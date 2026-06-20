// Neonfi backend — POST /portfolios/:id/assets/bulk tests (retrofit-87).
//
// CSV bulk import of STARTING ASSETS for MANUAL portfolios. Real DB + Redis, per-test
// truncation. Mirrors assets.test.ts. The cost mode is DERIVED from the column combo
// (cost_per_unit → avg, else acquired_date → historical, else none).

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

const AUTH_BASE = '/api/v1/auth';
const TEST_EMAIL = 'assets.bulk@neonfi.test';
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
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, fullName: 'Assets Bulk' }),
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
  return app.request(`/api/v1/portfolios/${portfolioId}/assets/bulk`, {
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
});

// ---------------------------------------------------------------------------
// Cost-mode derivation: avg / none
// ---------------------------------------------------------------------------

it('derives avg (cost_per_unit) and none (no cost) openings correctly', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'all_or_nothing',
      rows: [
        { symbol: 'BTC', quantity: '2', costPerUnit: '50000' }, // avg
        { symbol: 'ETH', quantity: '3' }, // none (cost-unknown)
      ],
    },
    cookies,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data).toMatchObject({ imported: 2, skipped: 0 });

  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.balance.toString())).toBeCloseTo(2);
  expect(Number(btc!.openingCostBasis!.toString())).toBeCloseTo(100000); // 2 × 50000
  expect(Number(btc!.avgCost!.toString())).toBeCloseTo(50000);

  const eth = await getAsset(portfolioId, ethId);
  expect(Number(eth!.balance.toString())).toBeCloseTo(3);
  expect(eth!.openingCostBasis).toBeNull(); // cost-unknown
  expect(eth!.avgCost).toBeNull();
});

// ---------------------------------------------------------------------------
// Cost-mode derivation: historical (needs a price snapshot on/before the date)
// ---------------------------------------------------------------------------

it('historical mode prices the opening from the nearest snapshot on/before acquired_date', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const snapDate = new Date('2025-07-15T00:00:00.000Z');
  await prisma.tokenPriceSnapshot.upsert({
    where: { tokenId_snapshotDate: { tokenId: ethId, snapshotDate: snapDate } },
    update: { price: '2500' },
    create: { tokenId: ethId, snapshotDate: snapDate, price: '2500' },
  });
  try {
    const res = await bulkPost(
      portfolioId,
      { mode: 'all_or_nothing', rows: [{ symbol: 'ETH', quantity: '4', acquiredDate: '2025-07-15' }] },
      cookies,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as BulkResp;
    expect(json.data!.imported).toBe(1);

    const eth = await getAsset(portfolioId, ethId);
    expect(Number(eth!.openingCostBasis!.toString())).toBeCloseTo(10000); // 4 × 2500
    expect(eth!.openingAt).not.toBeNull();
  } finally {
    await prisma.tokenPriceSnapshot.deleteMany({ where: { tokenId: ethId, snapshotDate: snapDate } });
  }
});

it('historical with no snapshot on/before the date → row error on acquired_date', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    { mode: 'skip_invalid', rows: [{ symbol: 'BTC', quantity: '1', acquiredDate: '2000-01-01' }] },
    cookies,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(0);
  expect(json.data!.errors[0]).toMatchObject({ row: 1, column: 'acquired_date' });
  expect(json.data!.errors[0]!.message).toContain('no price history');
});

// ---------------------------------------------------------------------------
// DUPLICATE_OPENING
// ---------------------------------------------------------------------------

it('opening a symbol already held in the portfolio → DUPLICATE_OPENING (no overwrite)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, openingBalance: '5', balance: '5' } });

  const res = await bulkPost(
    portfolioId,
    { mode: 'skip_invalid', rows: [{ symbol: 'BTC', quantity: '1', costPerUnit: '100' }] },
    cookies,
  );
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(0);
  expect(json.data!.errors[0]).toMatchObject({ row: 1, column: 'symbol' });
  expect(json.data!.errors[0]!.message).toContain('already has a starting position');
  // The pre-existing opening is untouched.
  const btc = await getAsset(portfolioId, btcId);
  expect(Number(btc!.openingBalance.toString())).toBeCloseTo(5);
});

it('the same symbol twice in one file → second row is DUPLICATE_OPENING', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'skip_invalid',
      rows: [
        { symbol: 'BTC', quantity: '1', costPerUnit: '100' },
        { symbol: 'BTC', quantity: '2', costPerUnit: '200' },
      ],
    },
    cookies,
  );
  const json = (await res.json()) as BulkResp;
  expect(json.data!.imported).toBe(1);
  expect(json.data!.skipped).toBe(1);
  expect(json.data!.errors[0]).toMatchObject({ row: 2, column: 'symbol' });
});

// ---------------------------------------------------------------------------
// Mixed validity — atomic rollback vs skip
// ---------------------------------------------------------------------------

it('mixed file in all_or_nothing → 400, nothing written, per-cell errors with column', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await bulkPost(
    portfolioId,
    {
      mode: 'all_or_nothing',
      rows: [
        { symbol: 'BTC', quantity: '1', costPerUnit: '100' }, // valid
        { symbol: 'ETH', quantity: 'oops' }, // bad quantity
        { symbol: 'FAKE', quantity: '1' }, // unknown symbol
      ],
    },
    cookies,
  );
  expect(res.status).toBe(400);
  const json = (await res.json()) as BulkResp;
  expect(json.error!.code).toBe('BULK_VALIDATION_FAILED');
  const find = (row: number) => json.data!.errors.find((e) => e.row === row);
  expect(find(2)).toMatchObject({ column: 'quantity', message: "expected a number, got 'oops'" });
  expect(find(3)).toMatchObject({ column: 'symbol', message: "'FAKE' is not a recognized token" });
  expect(await prisma.asset.count({ where: { portfolioId } })).toBe(0);
});

// ---------------------------------------------------------------------------
// Structural rejections
// ---------------------------------------------------------------------------

it('connected portfolio → 400 NOT_MANUAL', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');
  const res = await bulkPost(
    portfolioId,
    { mode: 'all_or_nothing', rows: [{ symbol: 'BTC', quantity: '1' }] },
    cookies,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as BulkResp).error!.code).toBe('NOT_MANUAL');
});

it('over 500 rows → 400 TOO_MANY_ROWS', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const rows = Array.from({ length: 501 }, () => ({ symbol: 'BTC', quantity: '1' }));
  const res = await bulkPost(portfolioId, { mode: 'skip_invalid', rows }, cookies);
  expect(res.status).toBe(400);
  expect(((await res.json()) as BulkResp).error!.code).toBe('TOO_MANY_ROWS');
});
