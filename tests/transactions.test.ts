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
// than registerAndLogin, which matters under a remote isolated test DB.
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
