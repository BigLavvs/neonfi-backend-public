// Neonfi backend — Transactions module integration tests (Stage 9A).
//
// Strategy: real DB + Redis, per-test truncation of
// payment → subscription → transaction → asset → portfolio → session → user.
// Token, chain, and lookup tables are NOT touched.

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock
// ---------------------------------------------------------------------------

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendUpgradeEmail: vi.fn().mockResolvedValue(undefined),
  sendDowngradeScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendCancellationScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendRefundConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendPlanDowngradeAppliedEmail: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_BASE = '/api/v1/auth';
const PORT_BASE = '/api/v1/portfolios';
const txBase = (portfolioId: number) =>
  `/api/v1/portfolios/${portfolioId}/transactions`;

const TEST_EMAIL = 'tx.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Tx Integration';

let btcId: number;
let ethId: number;
let usdtId: number;

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
  fullName = TEST_FULL_NAME,
): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function seedPortfolio(userId: number, type: 'connected' | 'manual'): Promise<number> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: type } });
  const p = await prisma.portfolio.create({
    data: { userId, name: `Test ${type}`, typeId: portfolioType.id },
  });
  return p.id;
}

async function addAssetDirectly(
  portfolioId: number,
  tokenId: number,
  balance = '0',
): Promise<void> {
  await prisma.asset.create({ data: { portfolioId, tokenId, balance } });
}

function txPost(
  portfolioId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(txBase(portfolioId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

function txGet(portfolioId: number, path: string, cookies?: string): Promise<Response> {
  return app.request(`${txBase(portfolioId)}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

function txPatch(
  portfolioId: number,
  txId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${txBase(portfolioId)}/${txId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

function txDelete(portfolioId: number, txId: number, cookies?: string): Promise<Response> {
  return app.request(`${txBase(portfolioId)}/${txId}`, {
    method: 'DELETE',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function getAssetBalance(portfolioId: number, tokenId: number): Promise<number> {
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId } },
  });
  return Number(asset.balance.toString());
}

const BTC_PRICE = 93000;
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Setup — token IDs from seeded lookup rows (never cleaned up)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
  usdtId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } })).id;
});

// payment → subscription → asset → portfolio → session → user
// (transaction cascades from portfolio via onDelete:Cascade)
beforeEach(async () => {
  await prisma.payment.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 198-207. POST /portfolios/:portfolioId/transactions
// ---------------------------------------------------------------------------

it('198: POST native buy → 201; Transaction row + NativeTransactionDetail created; Asset.balance updated', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const res = await txPost(
    portfolioId,
    {
      type: 'native',
      direction: 'buy',
      amount: '0.5',
      symbol: 'BTC',
      timestamp: TIMESTAMP,
    },
    cookies,
  );
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { transaction: Record<string, unknown> } };
  const tx = json.data.transaction;
  expect(tx.type).toBe('native');
  expect(tx.direction).toBe('buy');
  expect((tx.detail as Record<string, unknown>).amount).toBe(0.5);
  expect((tx.detail as Record<string, unknown>).symbol).toBe('BTC');

  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.5);
  expect(await prisma.transaction.count()).toBe(1);
  expect(await prisma.nativeTransactionDetail.count()).toBe(1);
});

it('199: POST erc20 buy → 201; Erc20TransactionDetail created with contract+symbol+amount', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, ethId);

  const res = await txPost(
    portfolioId,
    {
      type: 'erc20',
      direction: 'buy',
      amount: '2.0',
      symbol: 'ETH',
      tokenContractAddress: '0xETHContract',
      tokenName: 'Ethereum',
      tokenSymbol: 'ETH',
      timestamp: TIMESTAMP,
    },
    cookies,
  );
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { transaction: Record<string, unknown> } };
  const tx = json.data.transaction;
  expect(tx.type).toBe('erc20');
  expect((tx.detail as Record<string, unknown>).tokenContractAddress).toBe('0xETHContract');
  expect(await prisma.erc20TransactionDetail.count()).toBe(1);
  expect(await getAssetBalance(portfolioId, ethId)).toBeCloseTo(2.0);
});

it('200: POST nft → 201; NftTransactionDetail created; Asset.balance NOT touched', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId, '1.0');

  const res = await txPost(
    portfolioId,
    {
      type: 'nft',
      direction: 'buy',
      tokenContractAddress: '0xNFTContract',
      nftTokenId: '42',
      nftName: 'Cool NFT',
      collectionName: 'Cool Collection',
      timestamp: TIMESTAMP,
    },
    cookies,
  );
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { transaction: Record<string, unknown> } };
  const tx = json.data.transaction;
  expect(tx.type).toBe('nft');
  expect((tx.detail as Record<string, unknown>).nftTokenId).toBe('42');
  expect(await prisma.nftTransactionDetail.count()).toBe(1);
  // NFT does NOT trigger balance recalc — BTC balance stays at 1.0
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);
});

it('201: POST sell → 201; Asset.balance decreases after prior buy', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'sell', amount: '0.3', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.7);
});

it('202: POST transfer → 201; Asset.balance UNCHANGED (transfer is no-op)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId, '2.0');

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '2.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'transfer', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  // buy=2.0 + transfer=no-op → balance remains 2.0
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(2.0);
});

it('203: POST connected portfolio → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
});

it('204: POST native with extra erc20 field → 400 VALIDATION_ERROR (strict)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const res = await txPost(
    portfolioId,
    {
      type: 'native',
      direction: 'buy',
      amount: '1.0',
      symbol: 'BTC',
      timestamp: TIMESTAMP,
      tokenContractAddress: '0xExtra', // extra erc20 field
    },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

it('205: POST duplicate transactionHash → 409 TRANSACTION_HASH_DUPLICATE', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const body = {
    type: 'native',
    direction: 'buy',
    amount: '1.0',
    symbol: 'BTC',
    timestamp: TIMESTAMP,
    transactionHash: '0xdeadbeef1234567890',
  };

  const first = await txPost(portfolioId, body, cookies);
  expect(first.status).toBe(201);

  const second = await txPost(portfolioId, body, cookies);
  expect(second.status).toBe(409);

  const json = await second.json() as { error: { code: string } };
  expect(json.error.code).toBe('TRANSACTION_HASH_DUPLICATE');
});

it('206: POST with unknown token symbol → 400 UNKNOWN_TOKEN_SYMBOL', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1.0', symbol: 'FAKECOIN', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNKNOWN_TOKEN_SYMBOL');
});

it('207: POST with token symbol not in portfolio (no Asset row) → 400 ASSET_NOT_IN_PORTFOLIO', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  // BTC is a known token but no asset added to this portfolio

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('ASSET_NOT_IN_PORTFOLIO');
});

// ---------------------------------------------------------------------------
// 208-211. GET /portfolios/:portfolioId/transactions
// ---------------------------------------------------------------------------

it('208: GET list with type filter → 200; only native transactions returned', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await addAssetDirectly(portfolioId, ethId);

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  await txPost(portfolioId, { type: 'erc20', direction: 'buy', amount: '2.0', symbol: 'ETH', tokenContractAddress: '0xETH', tokenName: 'Ethereum', tokenSymbol: 'ETH', timestamp: TIMESTAMP }, cookies);

  const res = await txGet(portfolioId, '?type=native', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transactions: Array<Record<string, unknown>> }; meta: Record<string, number> };
  expect(json.data.transactions).toHaveLength(1);
  expect(json.data.transactions[0]!.type).toBe('native');
  expect(json.meta.total).toBe(1);
});

it('209: GET list with sort=timestamp,order=desc → 200; newest first', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: '2026-01-01T00:00:00.000Z' }, cookies);
  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: '2026-01-02T00:00:00.000Z' }, cookies);

  const res = await txGet(portfolioId, '?sort=timestamp&order=desc', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transactions: Array<Record<string, unknown>> } };
  expect(json.data.transactions).toHaveLength(2);
  // First entry should be the Jan 2 tx (newest)
  expect(json.data.transactions[0]!.timestamp).toContain('2026-01-02');
  expect(json.data.transactions[1]!.timestamp).toContain('2026-01-01');
});

it('210: GET list pagination → 200; limit+offset honored', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  for (let i = 0; i < 5; i++) {
    await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.1', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  }

  const res = await txGet(portfolioId, '?limit=2&offset=1', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transactions: unknown[] }; meta: Record<string, number> };
  expect(json.data.transactions).toHaveLength(2);
  expect(json.meta.limit).toBe(2);
  expect(json.meta.offset).toBe(1);
  expect(json.meta.total).toBe(5);
}, 90000);

it('211: GET list of connected portfolio → 200 (read allowed)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const res = await txGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transactions: unknown[] }; meta: { total: number } };
  expect(json.data.transactions).toEqual([]);
  expect(json.meta.total).toBe(0);
});

// ---------------------------------------------------------------------------
// 212-214. GET /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

it('212: GET native detail → 200; nativeDetail populated; erc20/nft detail null (not present)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const postJson = await postRes.json() as { data: { transaction: { id: number } } };
  const txId = postJson.data.transaction.id;

  const res = await txGet(portfolioId, `/${txId}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transaction: Record<string, unknown> } };
  const tx = json.data.transaction;
  expect(tx.type).toBe('native');
  expect(tx.direction).toBe('buy');
  const detail = tx.detail as Record<string, unknown>;
  expect(detail.amount).toBe(1.0);
  expect(detail.symbol).toBe('BTC');
  expect(detail.tokenContractAddress).toBeUndefined();
  expect(detail.nftTokenId).toBeUndefined();
});

it('213: GET erc20 detail → 200; erc20Detail populated', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, ethId);

  const postRes = await txPost(portfolioId, {
    type: 'erc20',
    direction: 'buy',
    amount: '2.0',
    symbol: 'ETH',
    tokenContractAddress: '0xETHContract',
    tokenName: 'Ethereum',
    tokenSymbol: 'ETH',
    timestamp: TIMESTAMP,
  }, cookies);
  const postJson = await postRes.json() as { data: { transaction: { id: number } } };
  const txId = postJson.data.transaction.id;

  const res = await txGet(portfolioId, `/${txId}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { transaction: Record<string, unknown> } };
  const detail = json.data.transaction.detail as Record<string, unknown>;
  expect(detail.tokenContractAddress).toBe('0xETHContract');
  expect(detail.amount).toBe(2.0);
});

it('214: GET non-existent transaction → 404 TRANSACTION_NOT_FOUND', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await txGet(portfolioId, '/999999', cookies);
  expect(res.status).toBe(404);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('TRANSACTION_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 215-219. PATCH /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

it('215: PATCH direction (buy→sell) → 200; Asset.balance recomputes', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.5);

  const patchRes = await txPatch(portfolioId, txId, { direction: 'sell' }, cookies);
  expect(patchRes.status).toBe(200);

  const json = await patchRes.json() as { data: { transaction: Record<string, unknown> } };
  expect(json.data.transaction.direction).toBe('sell');
  // buy→sell recalc: now it's -0.5
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(-0.5);
});

it('216: PATCH amount → 200; balance recomputes', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  const patchRes = await txPatch(portfolioId, txId, { amount: '2.5' }, cookies);
  expect(patchRes.status).toBe(200);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(2.5);
});

it('217: PATCH symbol (token change) → 200; OLD token balance loses tx; NEW token balance gains it', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await addAssetDirectly(portfolioId, ethId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);
  expect(await getAssetBalance(portfolioId, ethId)).toBeCloseTo(0.0);

  const patchRes = await txPatch(portfolioId, txId, { symbol: 'ETH' }, cookies);
  expect(patchRes.status).toBe(200);
  // BTC loses the tx → balance back to 0; ETH gains it → balance 1.0
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.0);
  expect(await getAssetBalance(portfolioId, ethId)).toBeCloseTo(1.0);
});

it('218: PATCH with `type` field → 400 VALIDATION_ERROR (type is immutable)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;

  const patchRes = await txPatch(portfolioId, txId, { type: 'erc20' } as Record<string, unknown>, cookies);
  expect(patchRes.status).toBe(400);

  const json = await patchRes.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

it('219: PATCH connected portfolio transaction → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const patchRes = await txPatch(portfolioId, 999, { direction: 'sell' }, cookies);
  expect(patchRes.status).toBe(403);

  const json = await patchRes.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
});

// ---------------------------------------------------------------------------
// 220-221. DELETE /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

it('220: DELETE manual transaction → 200; row gone; child gone via cascade; balance recomputes', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  const delRes = await txDelete(portfolioId, txId, cookies);
  expect(delRes.status).toBe(200);

  const json = await delRes.json() as { data: { ok: boolean } };
  expect(json.data.ok).toBe(true);
  expect(await prisma.transaction.count()).toBe(0);
  expect(await prisma.nativeTransactionDetail.count()).toBe(0);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.0);
});

it('221: DELETE connected portfolio transaction → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const delRes = await txDelete(portfolioId, 999, cookies);
  expect(delRes.status).toBe(403);

  const json = await delRes.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
});

// ---------------------------------------------------------------------------
// 222-223. Balance recalc cascade
// ---------------------------------------------------------------------------

it('222: Full lifecycle — buy/buy/sell/delete recalc cascade (negative balance accepted as MVP)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  // buy 1.0
  const r1 = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: '2026-01-01T00:00:00.000Z' }, cookies);
  const firstTxId = ((await r1.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  // buy 0.5
  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: '2026-01-02T00:00:00.000Z' }, cookies);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.5);

  // sell 0.3
  await txPost(portfolioId, { type: 'native', direction: 'sell', amount: '0.3', symbol: 'BTC', timestamp: '2026-01-03T00:00:00.000Z' }, cookies);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.2);

  // delete the first buy (1.0) — balance becomes 0.5 - 0.3 = 0.2
  const delRes = await txDelete(portfolioId, firstTxId, cookies);
  expect(delRes.status).toBe(200);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.2);
}, 90000);

it('223: Portfolio totalValue includes transaction-derived balance — 1 BTC buy at 93000 = totalValue 93000', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  const portRes = await app.request(`${PORT_BASE}/${portfolioId}`, {
    method: 'GET',
    headers: { Cookie: cookies },
  });
  expect(portRes.status).toBe(200);

  const portJson = await portRes.json() as { data: { portfolio: { totalValue: number } } };
  expect(portJson.data.portfolio.totalValue).toBeCloseTo(BTC_PRICE * 1.0);
});

// ---------------------------------------------------------------------------
// 224. Schema delta confirmation
// ---------------------------------------------------------------------------

it('224: transaction_direction seed — count=3; names are buy, sell, transfer', async () => {
  const count = await prisma.transactionDirection.count();
  expect(count).toBe(3);

  const rows = await prisma.transactionDirection.findMany({ orderBy: { name: 'asc' } });
  const names = rows.map((r) => r.name);
  expect(names).toEqual(['buy', 'sell', 'transfer']);
});
