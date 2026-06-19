// Neonfi backend — Transactions module integration tests (Stage 9A).
//
// Strategy: real DB + Redis, per-test truncation of
// payment → subscription → transaction → asset → portfolio → session → user.
// Token, chain, and lookup tables are NOT touched.

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';
import { portfolioDerivedCacheKeys } from '../src/lib/portfolio-cache-keys.js';

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
let linkId: number;

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

// Create a user row directly (no HTTP register/login, no bcrypt) — for fixtures like
// a "different owner" portfolio where we never authenticate as the user. Far lighter
// than registerAndLogin, which matters under the slow Neon dev DB.
async function seedUserDirect(email: string): Promise<number> {
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const u = await prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: 'Other User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  return u.id;
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

// retrofit-10: POST /portfolios/:portfolioId/transactions/transfer (source = URL id).
function txTransfer(
  portfolioId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${txBase(portfolioId)}/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function getAssetBalance(portfolioId: number, tokenId: number): Promise<number> {
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId } },
  });
  return Number(asset.balance.toString());
}

async function getAssetNetDeposit(portfolioId: number, tokenId: number): Promise<number> {
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId } },
  });
  return Number(asset.netDeposit.toString());
}

async function getPortfolioNetDeposit(portfolioId: number): Promise<number> {
  const p = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  return Number(p.netDeposit.toString());
}

async function getNativeUsdValue(txId: number): Promise<number> {
  const d = await prisma.nativeTransactionDetail.findUniqueOrThrow({
    where: { transactionId: txId },
  });
  return Number(d.usdValue.toString());
}

async function getErc20UsdValue(txId: number): Promise<number> {
  const d = await prisma.erc20TransactionDetail.findUniqueOrThrow({
    where: { transactionId: txId },
  });
  return Number(d.usdValue.toString());
}

// computeUsdValue checks Redis `price:<SYMBOL>` (60s, Coinbase WS) before falling
// back to Token.currentPrice. The WS does not run in tests (only src/index.ts
// connects it), but clear any stray keys so these assertions are hermetic against
// the DB-seeded price.
async function clearPriceCache(...symbols: string[]): Promise<void> {
  await Promise.all(symbols.map((s) => redis.del(`price:${s}`)));
}

const BTC_PRICE = 93000;
const ETH_PRICE = 3200;
const LINK_PRICE = 14.8;
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Setup — token IDs from seeded lookup rows (never cleaned up)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
  usdtId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } })).id;
  linkId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'LINK' } })).id;
});

// payment → subscription → asset → portfolio → session → user
// (transaction cascades from portfolio via onDelete:Cascade)
beforeEach(async () => {
  await truncateAllUserData();
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
  expect(tx.status).toBe('completed'); // A7 — hardcoded MVP status
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

// retrofit-73 (R43/R44/R45): transaction input validation — zero, over-large, and future-dated.
it('r73-amount-zero: POST amount 0 → 400 VALIDATION_ERROR (not a $0 transaction)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
});

it('r73-amount-huge: POST amount 1e15 → 400 VALIDATION_ERROR (not a 500 Decimal overflow)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1000000000000000', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400); // bounded by the schema, never reaches the Decimal column
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
});

it('r73-future-ts: POST timestamp in 2099 → 400 VALIDATION_ERROR', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: '2099-01-01T00:00:00.000Z' },
    cookies,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
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

it('207: POST SELL of a token not in portfolio (no Asset row) → 400 ASSET_NOT_IN_PORTFOLIO (retrofit-27 §6)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  // BTC is a known token but no asset added. A BUY would auto-create it (test 345);
  // a SELL/transfer of an unheld token is still rejected.

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'sell', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP },
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
  expect(tx.status).toBe('completed'); // A7 — TransactionDetailDTO inherits status
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

// ---------------------------------------------------------------------------
// 303-310. retrofit-2 — usdValue persistence, netDeposit tracking, list shape,
// PnL cache invalidation.
// ---------------------------------------------------------------------------

it('303: POST native buy → NativeTransactionDetail.usdValue = amount × Token.currentPrice', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  const txId = ((await res.json()) as { data: { transaction: { id: number } } }).data.transaction.id;

  // 0.5 × 93000 = 46500
  expect(await getNativeUsdValue(txId)).toBeCloseTo(0.5 * BTC_PRICE);
});

it('304: POST erc20 buy → Erc20TransactionDetail.usdValue = amount × Token.currentPrice', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, linkId);
  await clearPriceCache('LINK');

  const res = await txPost(
    portfolioId,
    {
      type: 'erc20',
      direction: 'buy',
      amount: '10',
      symbol: 'LINK',
      tokenContractAddress: '0xLINKContract',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      timestamp: TIMESTAMP,
    },
    cookies,
  );
  expect(res.status).toBe(201);
  const txId = ((await res.json()) as { data: { transaction: { id: number } } }).data.transaction.id;

  // 10 × 14.80 = 148
  expect(await getErc20UsdValue(txId)).toBeCloseTo(10 * LINK_PRICE);
});

it('305: POST native buy then sell → Asset.netDeposit = buy.usdValue − sell.usdValue', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  await txPost(portfolioId, { type: 'native', direction: 'sell', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);

  // balance = 1.0 − 0.5 = 0.5 ; netDeposit = 93000 − 46500 = 46500
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0.5);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(1.0 * BTC_PRICE - 0.5 * BTC_PRICE);
});

it('306: Portfolio.netDeposit = sum of asset netDeposits after buys/sells', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  await txPost(portfolioId, { type: 'native', direction: 'sell', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);

  // Only one asset (BTC), so portfolio.netDeposit equals its netDeposit = 46500
  expect(await getPortfolioNetDeposit(portfolioId)).toBeCloseTo(1.0 * BTC_PRICE - 0.5 * BTC_PRICE);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(
    await getPortfolioNetDeposit(portfolioId),
  );
});

it('307: GET list → each native/erc20 row carries amount, symbol, usdValue', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await addAssetDirectly(portfolioId, linkId);
  await clearPriceCache('BTC', 'LINK');

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  await txPost(portfolioId, {
    type: 'erc20',
    direction: 'buy',
    amount: '10',
    symbol: 'LINK',
    tokenContractAddress: '0xLINKContract',
    tokenName: 'Chainlink',
    tokenSymbol: 'LINK',
    timestamp: TIMESTAMP,
  }, cookies);

  const res = await txGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { transactions: Array<Record<string, unknown>> } };
  const rows = json.data.transactions;
  expect(rows).toHaveLength(2);

  const native = rows.find((r) => r.type === 'native')!;
  expect(native.amount).toBe(0.5);
  expect(native.symbol).toBe('BTC');
  expect(native.usdValue).toBeCloseTo(0.5 * BTC_PRICE);

  const erc20 = rows.find((r) => r.type === 'erc20')!;
  expect(erc20.amount).toBe(10);
  expect(erc20.symbol).toBe('LINK');
  expect(erc20.usdValue).toBeCloseTo(10 * LINK_PRICE);
});

it('308: PATCH amount on native tx → usdValue recomputed (doubles when amount doubles)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  const postRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getNativeUsdValue(txId)).toBeCloseTo(0.5 * BTC_PRICE);

  const patchRes = await txPatch(portfolioId, txId, { amount: '1.0' }, cookies);
  expect(patchRes.status).toBe(200);

  // usdValue doubles: 46500 → 93000 ; netDeposit follows
  expect(await getNativeUsdValue(txId)).toBeCloseTo(1.0 * BTC_PRICE);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(1.0 * BTC_PRICE);
});

it('309: DELETE → asset balance, asset netDeposit, portfolio netDeposit all recompute', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await addAssetDirectly(portfolioId, ethId);
  await clearPriceCache('BTC', 'ETH');

  // buy 1 BTC (native) + buy 1 ETH (native)
  const btcRes = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  const btcTxId = ((await btcRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'ETH', timestamp: TIMESTAMP }, cookies);

  // pre-delete portfolio netDeposit = BTC(93000) + ETH(3200) = 96200
  expect(await getPortfolioNetDeposit(portfolioId)).toBeCloseTo(BTC_PRICE + ETH_PRICE);

  const delRes = await txDelete(portfolioId, btcTxId, cookies);
  expect(delRes.status).toBe(200);

  // BTC fully removed; only ETH state remains
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(0);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(0);
  expect(await getAssetBalance(portfolioId, ethId)).toBeCloseTo(1.0);
  expect(await getAssetNetDeposit(portfolioId, ethId)).toBeCloseTo(ETH_PRICE);
  expect(await getPortfolioNetDeposit(portfolioId)).toBeCloseTo(ETH_PRICE);
}, 90000);

it('310: POST → PnL cache invalidated once with key portfolio_pnl:<id>', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  const delSpy = vi.spyOn(redis, 'del');
  try {
    const res = await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
    expect(res.status).toBe(201);

    // Stage 14: invalidatePnlCache now deletes the full derived-cache key set
    // (portfolio_pnl + 3 analytics keys) in one variadic redis.del call. Assert the
    // call carries the exact key set, and that exactly one del call includes the
    // portfolio_pnl key (still strong signal — not loosened to "called at least once").
    const key = `portfolio_pnl:${portfolioId}`;
    expect(delSpy).toHaveBeenCalledWith(...portfolioDerivedCacheKeys(portfolioId));
    const pnlCalls = delSpy.mock.calls.filter((c) => c.includes(key));
    expect(pnlCalls).toHaveLength(1);
  } finally {
    delSpy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// 311-316. retrofit-7 — user-entered priceAtTime drives usdValue for manual
// buy/sell (accurate cost basis), + transaction notes. priceAtTime is OPTIONAL:
// omitting it keeps the retrofit-2 current-price path. Webhook/connected unchanged.
// ---------------------------------------------------------------------------

it('311: POST native buy with priceAtTime → usdValue = amount × priceAtTime (NOT current price); netDeposit follows', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  // priceAtTime (30000) deliberately differs from current BTC_PRICE (93000) to prove
  // the entered price — not the current price — drives usdValue.
  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    data: { transaction: { id: number; detail: Record<string, unknown> } };
  };
  const txId = json.data.transaction.id;

  // usdValue = 1 × 30000 = 30000 (entered price), NOT 1 × 93000.
  expect(await getNativeUsdValue(txId)).toBeCloseTo(30000);
  expect(await getNativeUsdValue(txId)).not.toBeCloseTo(BTC_PRICE);
  // accurate cost basis flows into netDeposit/PnL
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(30000);
  expect(await getPortfolioNetDeposit(portfolioId)).toBeCloseTo(30000);
  // priceAtTime surfaced on the detail DTO
  expect(json.data.transaction.detail.priceAtTime).toBe(30000);
});

it('312: POST native buy WITHOUT priceAtTime → usdValue = current price (back-compat); detail.priceAtTime null', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    data: { transaction: { id: number; detail: Record<string, unknown> } };
  };
  const txId = json.data.transaction.id;

  // current-price path intact: 0.5 × 93000 = 46500
  expect(await getNativeUsdValue(txId)).toBeCloseTo(0.5 * BTC_PRICE);
  // no override entered → priceAtTime persisted as null
  expect(json.data.transaction.detail.priceAtTime).toBeNull();
});

it('313: POST erc20 buy with priceAtTime → usdValue = amount × priceAtTime; detail.priceAtTime surfaced', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, linkId);
  await clearPriceCache('LINK');

  const res = await txPost(
    portfolioId,
    {
      type: 'erc20',
      direction: 'buy',
      amount: '10',
      symbol: 'LINK',
      tokenContractAddress: '0xLINKContract',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      priceAtTime: '20',
      timestamp: TIMESTAMP,
    },
    cookies,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    data: { transaction: { id: number; detail: Record<string, unknown> } };
  };
  const txId = json.data.transaction.id;

  // 10 × 20 = 200 (entered), NOT 10 × 14.80 (current)
  expect(await getErc20UsdValue(txId)).toBeCloseTo(200);
  expect(await getErc20UsdValue(txId)).not.toBeCloseTo(10 * LINK_PRICE);
  expect(json.data.transaction.detail.priceAtTime).toBe(20);
  expect(await getAssetNetDeposit(portfolioId, linkId)).toBeCloseTo(200);
});

it('314: notes persists → surfaced on the detail DTO (POST) and the list DTO (GET)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  const postRes = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', notes: 'DCA tranche #3', timestamp: TIMESTAMP },
    cookies,
  );
  expect(postRes.status).toBe(201);
  const postJson = (await postRes.json()) as { data: { transaction: Record<string, unknown> } };
  // notes on the detail (POST) response
  expect(postJson.data.transaction.notes).toBe('DCA tranche #3');

  // notes on the list response
  const listRes = await txGet(portfolioId, '', cookies);
  expect(listRes.status).toBe(200);
  const listJson = (await listRes.json()) as {
    data: { transactions: Array<Record<string, unknown>> };
  };
  expect(listJson.data.transactions).toHaveLength(1);
  expect(listJson.data.transactions[0].notes).toBe('DCA tranche #3');
});

it('315: PATCH priceAtTime → usdValue recomputed and netDeposit follows; detail.priceAtTime updated', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  // Logged WITHOUT priceAtTime → current price 93000.
  const postRes = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getNativeUsdValue(txId)).toBeCloseTo(BTC_PRICE);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(BTC_PRICE);

  // Correct the entered price → usdValue recomputes to 1 × 25000, and netDeposit
  // must follow even though amount (and thus balance) is unchanged.
  const patchRes = await txPatch(portfolioId, txId, { priceAtTime: '25000' }, cookies);
  expect(patchRes.status).toBe(200);
  const patchJson = (await patchRes.json()) as { data: { transaction: { detail: Record<string, unknown> } } };

  expect(await getNativeUsdValue(txId)).toBeCloseTo(25000);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(25000);
  expect(await getPortfolioNetDeposit(portfolioId)).toBeCloseTo(25000);
  expect(patchJson.data.transaction.detail.priceAtTime).toBe(25000);
});

it('316: PATCH amount on a tx with a stored priceAtTime → recompute keeps the entered price; PATCH notes updates note', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  // Logged WITH priceAtTime 30000 and a note.
  const postRes = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '1', symbol: 'BTC', priceAtTime: '30000', notes: 'first', timestamp: TIMESTAMP },
    cookies,
  );
  const txId = ((await postRes.json()) as { data: { transaction: { id: number } } }).data.transaction.id;
  expect(await getNativeUsdValue(txId)).toBeCloseTo(30000);

  // PATCH amount only (no new priceAtTime) → recompute uses the STORED priceAtTime
  // (30000), NOT current price: 2 × 30000 = 60000.
  const patchAmt = await txPatch(portfolioId, txId, { amount: '2' }, cookies);
  expect(patchAmt.status).toBe(200);
  expect(await getNativeUsdValue(txId)).toBeCloseTo(60000);
  expect(await getNativeUsdValue(txId)).not.toBeCloseTo(2 * BTC_PRICE);
  expect(await getAssetNetDeposit(portfolioId, btcId)).toBeCloseTo(60000);

  // PATCH notes → updated and surfaced.
  const patchNotes = await txPatch(portfolioId, txId, { notes: 'second' }, cookies);
  expect(patchNotes.status).toBe(200);
  const detail = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
  expect(detail.notes).toBe('second');
});

// ---------------------------------------------------------------------------
// 317-322. retrofit-10 (C4b) — cross-portfolio transfer. A move between two of the
// user's MANUAL portfolios is a PAIRED transaction: a `sell` leg in the source + a
// `buy` leg in the dest, sharing a transferGroupId. The dest inherits the source's
// per-unit cost basis (both legs use usdValue = amount × netDeposit/balance) so total
// basis is conserved and the move creates no fake PnL. recalc.ts is reused unchanged.
// ---------------------------------------------------------------------------

it('317: POST transfer → paired sell/buy legs share transferGroupId; balances + basis move; total cost basis conserved (no fake PnL)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const source = await seedPortfolio(userId, 'manual');
  const dest = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(source, btcId);
  await clearPriceCache('BTC');

  // Seed source: 2 BTC at entered price 30000 → balance 2, netDeposit 60000.
  const buyRes = await txPost(
    source,
    { type: 'native', direction: 'buy', amount: '2', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );
  expect(buyRes.status).toBe(201);
  expect(await getAssetBalance(source, btcId)).toBeCloseTo(2);
  expect(await getAssetNetDeposit(source, btcId)).toBeCloseTo(60000);

  // Transfer 1 BTC source → dest.
  const res = await txTransfer(
    source,
    { destPortfolioId: dest, symbol: 'BTC', amount: '1', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);
  const t = ((await res.json()) as {
    data: {
      transfer: {
        transferGroupId: string;
        source: { id: number; portfolioId: number; direction: string; transferGroupId: string | null };
        dest: { id: number; portfolioId: number; direction: string; transferGroupId: string | null };
      };
    };
  }).data.transfer;

  // Two legs, same transferGroupId; sell in source, buy in dest.
  expect(typeof t.transferGroupId).toBe('string');
  expect(t.source.transferGroupId).toBe(t.transferGroupId);
  expect(t.dest.transferGroupId).toBe(t.transferGroupId);
  expect(t.source.direction).toBe('sell');
  expect(t.dest.direction).toBe('buy');
  expect(t.source.portfolioId).toBe(source);
  expect(t.dest.portfolioId).toBe(dest);

  // Per-unit basis (30000) carried onto BOTH legs.
  expect(await getNativeUsdValue(t.source.id)).toBeCloseTo(30000);
  expect(await getNativeUsdValue(t.dest.id)).toBeCloseTo(30000);

  // Balances moved: source 2→1, dest 0→1.
  expect(await getAssetBalance(source, btcId)).toBeCloseTo(1);
  expect(await getAssetBalance(dest, btcId)).toBeCloseTo(1);

  // Cost basis carried: source 60000→30000, dest 0→30000 (asset + portfolio level).
  expect(await getAssetNetDeposit(source, btcId)).toBeCloseTo(30000);
  expect(await getAssetNetDeposit(dest, btcId)).toBeCloseTo(30000);
  expect(await getPortfolioNetDeposit(source)).toBeCloseTo(30000);
  expect(await getPortfolioNetDeposit(dest)).toBeCloseTo(30000);

  // Total basis conserved (60000) → no fake PnL created by the move.
  const totalBasis =
    (await getAssetNetDeposit(source, btcId)) + (await getAssetNetDeposit(dest, btcId));
  expect(totalBasis).toBeCloseTo(60000);

  // Exactly two legs for this group.
  expect(
    await prisma.transaction.count({ where: { transferGroupId: t.transferGroupId } }),
  ).toBe(2);
});

it('318: POST transfer with amount > balance → 400 INSUFFICIENT_BALANCE; nothing written', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const source = await seedPortfolio(userId, 'manual');
  const dest = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(source, btcId);
  await clearPriceCache('BTC');
  await txPost(
    source,
    { type: 'native', direction: 'buy', amount: '2', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );
  const before = await prisma.transaction.count();

  const res = await txTransfer(
    source,
    { destPortfolioId: dest, symbol: 'BTC', amount: '5', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INSUFFICIENT_BALANCE');

  // Atomic failure: no new tx rows, source balance untouched, dest asset never created.
  expect(await prisma.transaction.count()).toBe(before);
  expect(await getAssetBalance(source, btcId)).toBeCloseTo(2);
  expect(
    await prisma.asset.findUnique({
      where: { portfolioId_tokenId: { portfolioId: dest, tokenId: btcId } },
    }),
  ).toBeNull();
});

it('319: transfer rejects bad dest — not found (403), not owned (403), connected (400), same-as-source (400)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const source = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(source, btcId);
  await clearPriceCache('BTC');
  await txPost(
    source,
    { type: 'native', direction: 'buy', amount: '2', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );

  // dest not found
  const r1 = await txTransfer(source, { destPortfolioId: 99999999, symbol: 'BTC', amount: '1' }, cookies);
  expect(r1.status).toBe(403);
  expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('DEST_NOT_FOUND');

  // dest owned by a different user (created directly — we never auth as them)
  const otherUserId = await seedUserDirect('other.tx@neonfi.test');
  const otherPortfolio = await seedPortfolio(otherUserId, 'manual');
  const r2 = await txTransfer(source, { destPortfolioId: otherPortfolio, symbol: 'BTC', amount: '1' }, cookies);
  expect(r2.status).toBe(403);
  expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('DEST_NOT_FOUND');

  // dest is connected
  const connectedDest = await seedPortfolio(userId, 'connected');
  const r3 = await txTransfer(source, { destPortfolioId: connectedDest, symbol: 'BTC', amount: '1' }, cookies);
  expect(r3.status).toBe(400);
  expect(((await r3.json()) as { error: { code: string } }).error.code).toBe('INVALID_TRANSFER_TARGET');

  // dest === source
  const r4 = await txTransfer(source, { destPortfolioId: source, symbol: 'BTC', amount: '1' }, cookies);
  expect(r4.status).toBe(400);
  expect(((await r4.json()) as { error: { code: string } }).error.code).toBe('INVALID_TRANSFER_TARGET');

  // No legs were written through any of the rejected attempts.
  expect(await prisma.transaction.count({ where: { transferGroupId: { not: null } } })).toBe(0);
});

it('320: transfer from a CONNECTED source → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connectedSource = await seedPortfolio(userId, 'connected');
  const dest = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(connectedSource, btcId, '2');

  const res = await txTransfer(
    connectedSource,
    { destPortfolioId: dest, symbol: 'BTC', amount: '1' },
    cookies,
  );
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    'CONNECTED_PORTFOLIO_READ_ONLY',
  );
});

it('321: DELETE one transfer leg → BOTH legs removed; both portfolios recalced; both caches cleared', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const source = await seedPortfolio(userId, 'manual');
  const dest = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(source, btcId);
  await clearPriceCache('BTC');
  await txPost(
    source,
    { type: 'native', direction: 'buy', amount: '2', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );

  const tRes = await txTransfer(
    source,
    { destPortfolioId: dest, symbol: 'BTC', amount: '1', timestamp: TIMESTAMP },
    cookies,
  );
  const t = ((await tRes.json()) as {
    data: { transfer: { transferGroupId: string; dest: { id: number } } };
  }).data.transfer;
  expect(
    await prisma.transaction.count({ where: { transferGroupId: t.transferGroupId } }),
  ).toBe(2);

  // Prime both portfolios' derived caches so we can prove both get cleared.
  await redis.set(portfolioDerivedCacheKeys(source)[0], 'x');
  await redis.set(portfolioDerivedCacheKeys(dest)[0], 'x');

  // Delete the DEST leg through the DEST portfolio (owner-gated). Both legs must vanish.
  const delRes = await txDelete(dest, t.dest.id, cookies);
  expect(delRes.status).toBe(200);

  expect(
    await prisma.transaction.count({ where: { transferGroupId: t.transferGroupId } }),
  ).toBe(0);

  // Source reverts to 2 BTC / 60000; dest back to 0 / 0.
  expect(await getAssetBalance(source, btcId)).toBeCloseTo(2);
  expect(await getAssetNetDeposit(source, btcId)).toBeCloseTo(60000);
  expect(await getPortfolioNetDeposit(source)).toBeCloseTo(60000);
  expect(await getAssetBalance(dest, btcId)).toBeCloseTo(0);
  expect(await getAssetNetDeposit(dest, btcId)).toBeCloseTo(0);
  expect(await getPortfolioNetDeposit(dest)).toBeCloseTo(0);

  // Both portfolios' caches cleared.
  expect(await redis.get(portfolioDerivedCacheKeys(source)[0])).toBeNull();
  expect(await redis.get(portfolioDerivedCacheKeys(dest)[0])).toBeNull();
});

it('322: TransactionListDTO surfaces transferGroupId — set on transfer legs, null for ordinary txns', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const source = await seedPortfolio(userId, 'manual');
  const dest = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(source, btcId);
  await clearPriceCache('BTC');

  // Ordinary buy → transferGroupId null on the response DTO.
  const buyRes = await txPost(
    source,
    { type: 'native', direction: 'buy', amount: '2', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );
  expect(
    ((await buyRes.json()) as { data: { transaction: { transferGroupId: string | null } } }).data
      .transaction.transferGroupId,
  ).toBeNull();

  // Transfer → both legs carry the same non-null transferGroupId.
  const tRes = await txTransfer(
    source,
    { destPortfolioId: dest, symbol: 'BTC', amount: '1', timestamp: TIMESTAMP },
    cookies,
  );
  const groupId = ((await tRes.json()) as { data: { transfer: { transferGroupId: string } } }).data
    .transfer.transferGroupId;

  // Source's list has the ordinary buy (null) AND the transfer sell leg (groupId).
  const listRes = await txGet(source, '', cookies);
  const txns = ((await listRes.json()) as {
    data: { transactions: Array<{ direction: string; transferGroupId: string | null }> };
  }).data.transactions;
  const sellLeg = txns.find((x) => x.direction === 'sell');
  const ordinaryBuy = txns.find((x) => x.direction === 'buy');
  expect(sellLeg?.transferGroupId).toBe(groupId);
  expect(ordinaryBuy?.transferGroupId).toBeNull();
});

// ---------------------------------------------------------------------------
// 345-347. retrofit-27 — auto-add asset on buy, reject oversell, average-cost realized PnL.
// ---------------------------------------------------------------------------

it('345: POST BUY of a token NOT yet in the portfolio → 201; asset auto-created; balance + avgCost set (retrofit-27 §6)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await clearPriceCache('BTC');
  // No addAssetDirectly — the buy itself creates the asset (auto-add).

  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', priceAtTime: '30000', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(201);

  expect(await prisma.asset.count({ where: { portfolioId } })).toBe(1);
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  expect(Number(asset.balance.toString())).toBeCloseTo(0.5);
  // The buy sets cost via the average-cost model (entered price drives avgCost).
  expect(Number(asset.avgCost!.toString())).toBeCloseTo(30000);
  expect(Number(asset.costBasis.toString())).toBeCloseTo(0.5 * 30000); // 15000
});

it('346: POST SELL exceeding holdings → 400 INSUFFICIENT_BALANCE; balance unchanged (retrofit-27 §6)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  // Hold 1 BTC.
  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1.0', symbol: 'BTC', timestamp: TIMESTAMP }, cookies);
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0);

  // Attempt to sell 2 BTC → rejected, no negative balance.
  const res = await txPost(
    portfolioId,
    { type: 'native', direction: 'sell', amount: '2.0', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INSUFFICIENT_BALANCE');
  expect(await getAssetBalance(portfolioId, btcId)).toBeCloseTo(1.0); // unchanged
});

it('347: average-cost realized PnL — buy 1@100, buy 1@200, sell 1@500 → avgCost 150, realizedPnl 350 (retrofit-27 §2)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId);
  await clearPriceCache('BTC');

  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1', symbol: 'BTC', priceAtTime: '100', timestamp: '2026-01-01T00:00:00.000Z' }, cookies);
  await txPost(portfolioId, { type: 'native', direction: 'buy', amount: '1', symbol: 'BTC', priceAtTime: '200', timestamp: '2026-01-02T00:00:00.000Z' }, cookies);
  await txPost(portfolioId, { type: 'native', direction: 'sell', amount: '1', symbol: 'BTC', priceAtTime: '500', timestamp: '2026-01-03T00:00:00.000Z' }, cookies);

  const asset = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  // After 2 buys: qty 2, avg 150. Sell 1 @500 → realized 1×(500−150)=350; remaining qty 1 @150.
  expect(Number(asset.balance.toString())).toBeCloseTo(1);
  expect(Number(asset.avgCost!.toString())).toBeCloseTo(150);
  expect(Number(asset.costBasis.toString())).toBeCloseTo(150);
  expect(Number(asset.realizedPnl.toString())).toBeCloseTo(350);
}, 90000);
