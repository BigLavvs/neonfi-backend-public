// Neonfi backend — POST /portfolios/:id/transactions/bulk tests (retrofit-87).
//
// CSV bulk import for MANUAL portfolios. Real DB + Redis, per-test truncation. Token catalog
// is a seeded lookup table (BTC/ETH/… never truncated). Mirrors the strategy of transactions.test.ts.

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

const AUTH_BASE = '/api/v1/auth';
const TEST_EMAIL = 'tx.bulk@neonfi.test';
const TEST_PASSWORD = 'Test1234';

let btcId: number;
let ethId: number;

interface BulkResp {
  data?: { imported: number; skipped: number; errors: Array<{ row: number; column: string | null; message: string }> };
  error?: { code: string; message: string };
}

async function registerAndLogin(): Promise<string> {
  await app.request(`${AUTH_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, fullName: 'Tx Bulk' }),
  });
  const res = await app.request(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(): Promise<number> {
  return (await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } })).id;
}

async function seedPortfolio(userId: number, type: 'connected' | 'manual'): Promise<number> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: type } });
  const p = await prisma.portfolio.create({ data: { userId, name: `Test ${type}`, typeId: portfolioType.id } });
  return p.id;
}

function bulkPost(portfolioId: number, body: unknown, cookies: string): Promise<Response> {
  return app.request(`/api/v1/portfolios/${portfolioId}/transactions/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify(body),
  });
}

async function getAsset(portfolioId: number, tokenId: number) {
  return prisma.asset.findUnique({ where: { portfolioId_tokenId: { portfolioId, tokenId } } });
}

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
});

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
  // Hermetic prices: no live WS in tests, so usdValue follows the per-row priceAtTime.
  await Promise.all([redis.del('price:BTC'), redis.del('price:ETH')]);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

it('all_or_nothing: imports every valid row, auto-creating assets; balances + usdValue match single-create', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'all_or_nothing',
      rows: [
        { type: 'buy', symbol: 'BTC', amount: '0.5', price: '90000', date: '2026-01-01' },
        { type: 'buy', symbol: 'ETH', amount: '2', price: '3000', date: '2026-01-02' },
      ],
    },
    cookies,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data).toMatchObject({ imported: 2, skipped: 0 });
  expect(json.data!.errors).toEqual([]);

  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.balance.toString())).toBeCloseTo(0.5);
  // usdValue = amount × priceAtTime → netDeposit/costBasis identical to single-create.
  expect(Number(btc!.netDeposit.toString())).toBeCloseTo(45000);
  expect(Number(btc!.avgCost!.toString())).toBeCloseTo(90000);

  const eth = await getAsset(portfolioId, ethId);
  expect(Number(eth!.balance.toString())).toBeCloseTo(2);
  expect(Number(eth!.netDeposit.toString())).toBeCloseTo(6000);

  // The native detail's usdValue is what New-Transaction → Buy would have written.
  const detail = await prisma.nativeTransactionDetail.findFirst({ where: { symbol: 'BTC' } });
  expect(Number(detail!.usdValue.toString())).toBeCloseTo(45000);
});

it('a later sell is funded by an earlier buy in the same file', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'all_or_nothing',
      rows: [
        { type: 'buy', symbol: 'BTC', amount: '1', price: '90000', date: '2026-01-01' },
        { type: 'sell', symbol: 'BTC', amount: '0.4', price: '95000', date: '2026-02-01' },
      ],
    },
    cookies,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(2);
  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.balance.toString())).toBeCloseTo(0.6);
});

// ---------------------------------------------------------------------------
// Mixed validity — all_or_nothing vs skip_invalid (atomic rollback)
// ---------------------------------------------------------------------------

const MIXED_ROWS = [
  { type: 'buy', symbol: 'BTC', amount: '0.1', price: '100', date: '2026-01-01' }, // row 1 — valid
  { type: 'purchase', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01' }, // row 2 — bad type
  { type: 'buy', symbol: 'BTC', amount: 'abc', price: '100', date: '2026-01-01' }, // row 3 — bad amount
  { type: 'buy', symbol: 'FAKE', amount: '1', price: '100', date: '2026-01-01' }, // row 4 — unknown symbol
  { type: 'buy', symbol: 'ETH', amount: '1', price: '100', date: '2099-01-01' }, // row 5 — future date
  { type: 'buy', symbol: 'ETH', amount: '1', price: '100', date: '2026-01-01', gasFee: 'xyz' }, // row 6 — bad gas_fee
];

it('mixed file in all_or_nothing → 400, writes NOTHING, returns every bad cell with row+column', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(portfolioId, { mode: 'all_or_nothing', rows: MIXED_ROWS }, cookies);
  expect(res.status).toBe(400);
  const json = (await res.json()) as BulkResp;
  expect(json.error!.code).toBe('BULK_VALIDATION_FAILED');
  const errs = json.data!.errors;

  const find = (row: number) => errs.find((e) => e.row === row);
  expect(find(2)).toMatchObject({ column: 'type', message: "must be buy or sell, got 'purchase'" });
  expect(find(3)).toMatchObject({ column: 'amount', message: "expected a number, got 'abc'" });
  expect(find(4)).toMatchObject({ column: 'symbol', message: "'FAKE' is not a recognized token" });
  expect(find(5)).toMatchObject({ column: 'date', message: 'date must be YYYY-MM-DD and not in the future' });
  expect(find(6)).toMatchObject({ column: 'gas_fee', message: "expected a number, got 'xyz'" });

  // Atomic rollback — not even the valid row 1 was written.
  expect(await prisma.transaction.count()).toBe(0);
  expect(await getAsset(portfolioId, btcId)).toBeNull();
});

it('same mixed file in skip_invalid → imports the valid row, skips the rest, errors match the bad rows', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(portfolioId, { mode: 'skip_invalid', rows: MIXED_ROWS }, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(1);
  expect(json.data!.skipped).toBe(5);
  expect(new Set(json.data!.errors.map((e) => e.row))).toEqual(new Set([2, 3, 4, 5, 6]));

  expect(await prisma.transaction.count()).toBe(1);
  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.balance.toString())).toBeCloseTo(0.1);
  // The ETH rows were both invalid → no ETH asset created.
  expect(await getAsset(portfolioId, ethId)).toBeNull();
});

// ---------------------------------------------------------------------------
// Business-rule parity with single-create
// ---------------------------------------------------------------------------

it('sell of an unheld token → ASSET_NOT_IN_PORTFOLIO-style row error', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    { mode: 'skip_invalid', rows: [{ type: 'sell', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01' }] },
    cookies,
  );
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(0);
  expect(json.data!.errors[0]).toMatchObject({ row: 1, column: 'symbol' });
  expect(json.data!.errors[0]!.message).toContain("don't hold");
});

it('oversell beyond the running balance → row error (amount)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'skip_invalid',
      rows: [
        { type: 'buy', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01' },
        { type: 'sell', symbol: 'BTC', amount: '2', price: '100', date: '2026-02-01' },
      ],
    },
    cookies,
  );
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(1);
  expect(json.data!.skipped).toBe(1);
  expect(json.data!.errors[0]).toMatchObject({ row: 2, column: 'amount' });
});

// ---------------------------------------------------------------------------
// Dedup on transactionHash — a duplicate is SKIPPED, not an error (even all_or_nothing)
// ---------------------------------------------------------------------------

it('duplicate transactionHash within the file → one imported, one skipped, no error', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'all_or_nothing',
      rows: [
        { type: 'buy', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01', transactionHash: '0xdup' },
        { type: 'buy', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-02', transactionHash: '0xdup' },
      ],
    },
    cookies,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data).toMatchObject({ imported: 1, skipped: 1 });
  expect(json.data!.errors).toEqual([]);
  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.balance.toString())).toBeCloseTo(1);
});

// ---------------------------------------------------------------------------
// Structural rejections
// ---------------------------------------------------------------------------

it('connected portfolio → 400 NOT_MANUAL, nothing written', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const res = await bulkPost(
    portfolioId,
    { mode: 'all_or_nothing', rows: [{ type: 'buy', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01' }] },
    cookies,
  );
  expect(res.status).toBe(400);
  const json = (await res.json()) as BulkResp;
  expect(json.error!.code).toBe('NOT_MANUAL');
  expect(await prisma.transaction.count()).toBe(0);
});

it('over 500 rows → 400 TOO_MANY_ROWS', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const rows = Array.from({ length: 501 }, () => ({
    type: 'buy',
    symbol: 'BTC',
    amount: '0.001',
    price: '1',
    date: '2026-01-01',
  }));
  const res = await bulkPost(portfolioId, { mode: 'skip_invalid', rows }, cookies);
  expect(res.status).toBe(400);
  const json = (await res.json()) as BulkResp;
  expect(json.error!.code).toBe('TOO_MANY_ROWS');
});

it("another user's portfolio → 403 (ownership middleware)", async () => {
  const cookies = await registerAndLogin();
  // A portfolio owned by a different user.
  const other = await prisma.user.create({
    data: {
      email: 'tx.bulk.other@neonfi.test',
      passwordHash: 'x',
      fullName: 'Other',
      authProvider: { connect: { name: 'email' } },
      onboardingStatus: { connect: { name: 'complete' } },
    },
  });
  const portfolioId = await seedPortfolio(other.id, 'manual');
  const res = await bulkPost(
    portfolioId,
    { mode: 'skip_invalid', rows: [{ type: 'buy', symbol: 'BTC', amount: '1', price: '100', date: '2026-01-01' }] },
    cookies,
  );
  expect(res.status).toBe(403);
});
