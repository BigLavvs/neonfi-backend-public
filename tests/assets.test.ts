// Neonfi backend — Assets module integration tests (Stage 8).
//
// Strategy: real DB + Redis, per-test truncation of payment → subscription →
// asset → portfolio → session → user. Token and chain tables are NOT touched.

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

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
const assetsBase = (portfolioId: number) => `/api/v1/portfolios/${portfolioId}/assets`;

const TEST_EMAIL = 'assets.integration@neonfi.test';
const TEST_EMAIL_2 = 'assets.integration2@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Assets Integration';

let btcId: number;
let ethId: number;
let usdtId: number;
let maticId: number;
let mkrId: number;

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

async function createFreeSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: null,
    },
  });
}

async function createProSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });
}

async function seedPortfolio(
  userId: number,
  type: 'connected' | 'manual',
  name?: string,
): Promise<number> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: type } });
  const p = await prisma.portfolio.create({
    data: { userId, name: name ?? `Test ${type}`, typeId: portfolioType.id },
  });
  return p.id;
}

async function addAssetDirectly(
  portfolioId: number,
  tokenId: number,
  opts: { balance?: string; netDeposit?: string } = {},
): Promise<number> {
  const asset = await prisma.asset.create({
    data: {
      portfolioId,
      tokenId,
      balance: opts.balance ?? '0',
      netDeposit: opts.netDeposit ?? '0',
    },
  });
  return asset.id;
}

function assetPost(
  portfolioId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(assetsBase(portfolioId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

function assetGet(portfolioId: number, path: string, cookies?: string): Promise<Response> {
  return app.request(`${assetsBase(portfolioId)}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

function assetPatch(
  portfolioId: number,
  assetId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${assetsBase(portfolioId)}/${assetId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

function assetDelete(portfolioId: number, assetId: number, cookies?: string): Promise<Response> {
  return app.request(`${assetsBase(portfolioId)}/${assetId}`, {
    method: 'DELETE',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

function portGet(portfolioId: number, cookies?: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Setup — token IDs from seeded lookup rows (never cleaned up)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
  usdtId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } })).id;
  maticId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'MATIC' } })).id;
  mkrId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'MKR' } })).id;
});

// payment → subscription → asset → portfolio → session → user
beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 173-180. POST /portfolios/:portfolioId/assets
// ---------------------------------------------------------------------------

// retrofit-27 §5: POST /assets now creates an OPENING position { tokenId, balance(>0), cost }.
it('173: POST manual opening position (cost=none) → 201, balance set, cost-unknown, full DTO shape', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: btcId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.portfolioId).toBe(portfolioId);
  expect(a.tokenId).toBe(btcId);
  expect(a.symbol).toBe('BTC');
  expect(a.name).toBe('Bitcoin');
  expect(a.balance).toBe(1);
  expect(a.netDeposit).toBe(0); // opening is not a deposit
  expect(a.price).toBe(93000);
  expect(a.value).toBe(93000); // 1 × 93000
  expect(a.portfolioPercentage).toBe(100);
  // retrofit-27 average-cost fields — cost-unknown holding
  expect(a.avgCost).toBeNull();
  expect(a.costTracked).toBe(false);
  expect(a.costBasis).toBe(0);
  expect(a.unrealizedPnlValue).toBe(0);
  expect(a.realizedPnlValue).toBe(0);
  expect(typeof a.id).toBe('number');
  expect(typeof a.createdAt).toBe('string');
  expect(await prisma.asset.count()).toBe(1);
});

it('174: POST connected portfolio → 403 CONNECTED_PORTFOLIO_READ_ONLY; no asset created', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');

  const res = await assetPost(portfolioId, { tokenId: btcId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
  expect(await prisma.asset.count()).toBe(0);
});

it('175: POST non-existent tokenId → 400 INVALID_TOKEN', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: 999999, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_TOKEN');
});

it('176: POST same tokenId twice → 201 then 409 ASSET_ALREADY_EXISTS', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const first = await assetPost(portfolioId, { tokenId: btcId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(first.status).toBe(201);

  const second = await assetPost(portfolioId, { tokenId: btcId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(second.status).toBe(409);

  const json = await second.json() as { error: { code: string } };
  expect(json.error.code).toBe('ASSET_ALREADY_EXISTS');
  expect(await prisma.asset.count()).toBe(1);
});

it('177: POST as free user with rank-1 token (BTC) → 201', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: btcId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(201);
});

it('178: POST as free user with rank-15 token (MATIC) → 403 PLAN_LIMIT_REACHED', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: maticId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string }; meta: Record<string, unknown> };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
  expect(json.meta.tokenSymbol).toBe('MATIC');
  expect(json.meta.plan).toBe('free');
  expect(json.meta.requiredRank).toBe(10);
});

it('179: POST as pro user with rank-30 token (MKR) → 201 (no plan gate on Pro)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: mkrId, balance: '1', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(201);
});

it('180: POST with unknown extra field → 400 VALIDATION_ERROR (strict)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(
    portfolioId,
    { tokenId: btcId, balance: '1', cost: { mode: 'none' }, bogus: true },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 181-184. GET /portfolios/:portfolioId/assets
// ---------------------------------------------------------------------------

it('181: GET empty portfolio → 200, assets=[]', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { assets: unknown[] } };
  expect(json.data.assets).toEqual([]);
});

it('182: GET portfolio with 3 assets → 3 returned, portfolioPercentage sums to 100', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId, { balance: '0.5' });   // value 46500
  await addAssetDirectly(portfolioId, ethId, { balance: '2.0' });   // value 6400
  await addAssetDirectly(portfolioId, usdtId, { balance: '100' });  // value 100

  const res = await assetGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { assets: Array<Record<string, unknown>> } };
  expect(json.data.assets).toHaveLength(3);

  const sumPct = json.data.assets.reduce(
    (sum, a) => sum + (a.portfolioPercentage as number),
    0,
  );
  expect(sumPct).toBeCloseTo(100, 10);
});

it('183: GET with ?slug=btc → 1 asset, portfolioPercentage relative to full portfolio', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId, { balance: '0.5' });  // value 46500
  await addAssetDirectly(portfolioId, ethId, { balance: '2.0' });  // value 6400

  const res = await assetGet(portfolioId, '?slug=btc', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { assets: Array<Record<string, unknown>> } };
  expect(json.data.assets).toHaveLength(1);
  expect(json.data.assets[0]!.symbol).toBe('BTC');

  // portfolioPercentage is relative to full portfolio (BTC+ETH = 52900), not just the filtered asset
  const expectedPct = (0.5 * 93000 / (0.5 * 93000 + 2.0 * 3200)) * 100; // 46500/52900
  expect(json.data.assets[0]!.portfolioPercentage as number).toBeCloseTo(expectedPct, 5);
});

it('184: GET connected portfolio assets → 200 (read allowed)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');
  await addAssetDirectly(portfolioId, btcId);

  const res = await assetGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { assets: Array<Record<string, unknown>> } };
  expect(json.data.assets).toHaveLength(1);
  expect(json.data.assets[0]!.symbol).toBe('BTC');
});

// ---------------------------------------------------------------------------
// 185-187. GET /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

it('185: GET own asset by id → 200, full AssetDTO with derived fields', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetGet(portfolioId, `/${assetId}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.id).toBe(assetId);
  expect(a.portfolioId).toBe(portfolioId);
  expect(a.tokenId).toBe(btcId);
  expect(a.symbol).toBe('BTC');
  expect(a.price).toBe(93000);
  expect(a.balance).toBe(0);
  expect(a.value).toBe(0);
  expect(a.portfolioPercentage).toBe(0);
  expect(a.netDeposit).toBe(0);
  expect(a.pnlAllTime).toBe(0);
  expect(a.pnlAllTimeValue).toBe(0);
});

it('186: GET asset belonging to a different portfolio → 404 ASSET_NOT_FOUND', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolio1Id = await seedPortfolio(userId, 'manual', 'Portfolio One');
  const portfolio2Id = await seedPortfolio(userId, 'manual', 'Portfolio Two');
  const assetId = await addAssetDirectly(portfolio1Id, btcId);

  const res = await assetGet(portfolio2Id, `/${assetId}`, cookies);
  expect(res.status).toBe(404);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('ASSET_NOT_FOUND');
});

it('187: GET non-existent asset id → 404 ASSET_NOT_FOUND', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetGet(portfolioId, '/999999', cookies);
  expect(res.status).toBe(404);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('ASSET_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 188-191. PATCH /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

it('188: PATCH netDeposit → 200, netDeposit updated, pnlAllTimeValue recomputes', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const assetId = await addAssetDirectly(portfolioId, btcId); // balance=0

  const res = await assetPatch(portfolioId, assetId, { netDeposit: '500.00' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.netDeposit).toBe(500);
  // value = 0 × 93000 = 0; pnlAllTimeValue = 0 − 500 = −500; pnlAllTime = −100%
  expect(a.pnlAllTimeValue).toBe(-500);
  expect(a.pnlAllTime).toBe(-100);
});

it('189: PATCH connected portfolio asset → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetPatch(portfolioId, assetId, { netDeposit: '500.00' }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
});

it('190: PATCH with stray field → 400 VALIDATION_ERROR (strict still applies)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetPatch(portfolioId, assetId, { bogusField: 'value' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

it('191: PATCH empty body → 400 VALIDATION_ERROR (refine requires at least one field)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetPatch(portfolioId, assetId, {}, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 192-193. DELETE /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

it('192: DELETE manual portfolio asset → 200, asset gone from DB', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetDelete(portfolioId, assetId, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { ok: boolean } };
  expect(json.data.ok).toBe(true);
  expect(await prisma.asset.count()).toBe(0);
});

it('193: DELETE connected portfolio asset → 403 CONNECTED_PORTFOLIO_READ_ONLY', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'connected');
  const assetId = await addAssetDirectly(portfolioId, btcId);

  const res = await assetDelete(portfolioId, assetId, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CONNECTED_PORTFOLIO_READ_ONLY');
  expect(await prisma.asset.count()).toBe(1);
});

// ---------------------------------------------------------------------------
// 194-196. Auth / portfolio-ownership guards
// ---------------------------------------------------------------------------

it('194: Asset endpoints without auth → 401', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const postRes = await assetPost(portfolioId, { tokenId: btcId });
  expect(postRes.status).toBe(401);

  const getRes = await assetGet(portfolioId, '');
  expect(getRes.status).toBe(401);
});

it("195: POST on another user's portfolio → 403 FORBIDDEN", async () => {
  const cookiesA = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userAId = await getUserId(TEST_EMAIL);
  const portfolioId = await seedPortfolio(userAId, 'manual');

  const cookiesB = await registerAndLogin(TEST_EMAIL_2, TEST_PASSWORD, 'User B');

  const res = await assetPost(portfolioId, { tokenId: btcId }, cookiesB);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

it('196: GET /assets on non-existent portfolio → 403 FORBIDDEN', async () => {
  const cookies = await registerAndLogin();

  const res = await assetGet(999999, '', cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 197. derive.ts cascade
// ---------------------------------------------------------------------------

it('197: Portfolio totalValue reflects asset sum — BTC 0.5 + ETH 2.0 = 52900', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await addAssetDirectly(portfolioId, btcId, { balance: '0.5' }); // 0.5 × 93000 = 46500
  await addAssetDirectly(portfolioId, ethId, { balance: '2.0' }); // 2.0 × 3200  =  6400

  const res = await portGet(portfolioId, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(json.data.portfolio.totalValue).toBe(52900);
});

// ---------------------------------------------------------------------------
// 339-341. retrofit-8 — asset-add optionally seeds an acquisition transaction
// ---------------------------------------------------------------------------

function txList(portfolioId: number, cookies?: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}/transactions`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

it('339: POST opening avg-cost → asset created with avgCost/costBasis; NO transaction seeded (retrofit-27 §5)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'avg', avgCost: '100' } }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.balance).toBe(2);
  expect(a.avgCost).toBe(100);
  expect(a.costBasis).toBe(200); // 2 × 100
  expect(a.costTracked).toBe(true);
  expect(a.netDeposit).toBe(200); // retrofit-69 (R39): opening cost basis now counts in netDeposit
  // unrealized = 2 × (93000 − 100) = 185800
  expect(a.unrealizedPnlValue).toBeCloseTo(2 * (93000 - 100));
  expect(a.realizedPnlValue).toBe(0);

  // Opening seeds NO transaction (acquisitions go through New Transaction → Buy).
  expect(await prisma.asset.count()).toBe(1);
  expect(await prisma.transaction.count()).toBe(0);
  expect(await prisma.nativeTransactionDetail.count()).toBe(0);

  // GET transactions returns an empty list.
  const txRes = await txList(portfolioId, cookies);
  const txJson = await txRes.json() as { data: { transactions: unknown[] } };
  expect(txJson.data.transactions).toHaveLength(0);
});

it('340: POST opening cost=none → cost-unknown holding (avgCost null), no transaction', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  expect(json.data.asset.balance).toBe(2);
  expect(json.data.asset.avgCost).toBeNull();
  expect(json.data.asset.costTracked).toBe(false);
  expect(json.data.asset.unrealizedPnlValue).toBe(0); // cost-unknown → no unrealized PnL

  expect(await prisma.asset.count()).toBe(1);
  expect(await prisma.transaction.count()).toBe(0);
});

it('341: POST opening as free user on a rank>10 token (MATIC) → 403 PLAN_LIMIT_REACHED, nothing created', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);
  const portfolioId = await seedPortfolio(userId, 'manual');

  const res = await assetPost(portfolioId, { tokenId: maticId, balance: '5', cost: { mode: 'avg', avgCost: '1' } }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');

  // Rank gate runs before any write — no asset, no transaction
  expect(await prisma.asset.count()).toBe(0);
  expect(await prisma.transaction.count()).toBe(0);
});

// retrofit-69 (R39): an opening lot's cost basis now flows into netDeposit so the legacy
// all-time PnL (totalValue − netDeposit) is honest. A stablecoin opening priced at its current
// value nets ~0 PnL instead of the old fake profit (whole value vs netDeposit 0).
it('r69: stablecoin opening priced at current value → netDeposit counts the opening, all-time PnL ≈ 0', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');
  await redis.del('price:USDT'); // hermetic on the seeded $1 currentPrice

  // Open 100 USDT at avg cost $1 (cost == current value).
  const res = await assetPost(
    portfolioId,
    { tokenId: usdtId, balance: '100', cost: { mode: 'avg', avgCost: '1' } },
    cookies,
  );
  expect(res.status).toBe(201);

  const a = (await res.json() as { data: { asset: Record<string, number> } }).data.asset;
  expect(a.netDeposit).toBe(100); // opening cost basis (100 × 1) now counted (was 0 pre-retrofit-69)
  expect(a.value).toBeCloseTo(100, 2);
  expect(a.pnlAllTimeValue).toBeCloseTo(0, 2); // 100 − 100, not a fake +100
  expect(a.pnlAllTime).toBeCloseTo(0, 2);

  // Portfolio.netDeposit mirrors the asset's opening basis (create adds).
  const p = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(Number(p.netDeposit.toString())).toBeCloseTo(100, 2);
});

it('392: POST opening historical with a snapshot on/before the date → costBasis = balance × nearest snapshot price (retrofit-27 §5)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  // TokenPriceSnapshot is GLOBAL catalog data (not cleaned by truncateAllUserData) —
  // start clean, seed a BTC close at 50000 on 2026-06-01, and clean up at the end.
  await prisma.tokenPriceSnapshot.deleteMany({ where: { tokenId: btcId } });
  await prisma.tokenPriceSnapshot.create({
    data: { tokenId: btcId, price: '50000', snapshotDate: new Date('2026-06-01T00:00:00.000Z') },
  });

  const res = await assetPost(
    portfolioId,
    { tokenId: btcId, balance: '2', cost: { mode: 'historical', date: '2026-06-10T00:00:00.000Z' } },
    cookies,
  );
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.balance).toBe(2);
  expect(a.avgCost).toBe(50000); // nearest close on/before 2026-06-10
  expect(a.costBasis).toBe(100000); // 2 × 50000
  expect(a.costTracked).toBe(true);

  await prisma.tokenPriceSnapshot.deleteMany({ where: { tokenId: btcId } });
});

it('393: POST opening historical with NO snapshot on/before the date → 400 PRICE_HISTORY_UNAVAILABLE; nothing created', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  await prisma.tokenPriceSnapshot.deleteMany({ where: { tokenId: btcId } }); // ensure none

  const res = await assetPost(
    portfolioId,
    { tokenId: btcId, balance: '2', cost: { mode: 'historical', date: '2020-01-01T00:00:00.000Z' } },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('PRICE_HISTORY_UNAVAILABLE');
  expect(await prisma.asset.count()).toBe(0);
});

// ---------------------------------------------------------------------------
// 394-398. retrofit-44 — PATCH opening position (balance + cost)
// ---------------------------------------------------------------------------

it('394: PATCH { balance, cost:avg } → openingBalance + costBasis recomputed; DTO reflects update', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  // Open with balance=2, avgCost=100 → costBasis=200
  const postRes = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'avg', avgCost: '100' } }, cookies);
  expect(postRes.status).toBe(201);
  const postJson = await postRes.json() as { data: { asset: Record<string, unknown> } };
  const assetId = postJson.data.asset.id as number;

  // Edit: balance=3, avgCost=200 → costBasis=600
  const res = await assetPatch(portfolioId, assetId, { balance: '3', cost: { mode: 'avg', avgCost: '200' } }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.balance).toBe(3);
  expect(a.avgCost).toBe(200);
  expect(a.costBasis).toBe(600); // 3 × 200
  expect(a.costTracked).toBe(true);

  // Idempotent: same PATCH again yields same result
  const res2 = await assetPatch(portfolioId, assetId, { balance: '3', cost: { mode: 'avg', avgCost: '200' } }, cookies);
  expect(res2.status).toBe(200);
  const json2 = await res2.json() as { data: { asset: Record<string, unknown> } };
  expect(json2.data.asset.balance).toBe(3);
  expect(json2.data.asset.costBasis).toBe(600);
});

it('395: PATCH { balance } only → rescales costBasis at prior per-unit avg; per-unit avgCost unchanged', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  // Open: balance=2, avgCost=100 → costBasis=200, per-unit=100
  const postRes = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'avg', avgCost: '100' } }, cookies);
  expect(postRes.status).toBe(201);
  const assetId = (await postRes.json() as { data: { asset: Record<string, unknown> } }).data.asset.id as number;

  // Balance-only edit: balance=4, cost omitted → rescale: 4 × 100 = 400
  const res = await assetPatch(portfolioId, assetId, { balance: '4' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.balance).toBe(4);
  expect(a.avgCost).toBe(100); // per-unit unchanged
  expect(a.costBasis).toBe(400); // rescaled: 4 × 100
  expect(a.costTracked).toBe(true);
});

it('396: PATCH { cost:none } → clears cost tracking; avgCost null, costTracked false; balance preserved', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  // Open with avg cost
  const postRes = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'avg', avgCost: '100' } }, cookies);
  expect(postRes.status).toBe(201);
  const assetId = (await postRes.json() as { data: { asset: Record<string, unknown> } }).data.asset.id as number;

  const res = await assetPatch(portfolioId, assetId, { cost: { mode: 'none' } }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { asset: Record<string, unknown> } };
  const a = json.data.asset;
  expect(a.avgCost).toBeNull();
  expect(a.costTracked).toBe(false);
  expect(a.balance).toBe(2); // balance preserved (balance-only edit keeps existing openingBalance)
});

it('397: PATCH { cost:historical, date } with no snapshot → 400 PRICE_HISTORY_UNAVAILABLE', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await seedPortfolio(userId, 'manual');

  const postRes = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'none' } }, cookies);
  expect(postRes.status).toBe(201);
  const assetId = (await postRes.json() as { data: { asset: Record<string, unknown> } }).data.asset.id as number;

  await prisma.tokenPriceSnapshot.deleteMany({ where: { tokenId: btcId } });

  const res = await assetPatch(
    portfolioId,
    assetId,
    { cost: { mode: 'historical', date: '2020-01-01T00:00:00.000Z' } },
    cookies,
  );
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('PRICE_HISTORY_UNAVAILABLE');
});

it('398: PATCH opening edit on another user\'s portfolio → 403 FORBIDDEN', async () => {
  const cookiesA = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userAId = await getUserId(TEST_EMAIL);
  const portfolioId = await seedPortfolio(userAId, 'manual');

  const postRes = await assetPost(portfolioId, { tokenId: btcId, balance: '2', cost: { mode: 'none' } }, cookiesA);
  expect(postRes.status).toBe(201);
  const assetId = (await postRes.json() as { data: { asset: Record<string, unknown> } }).data.asset.id as number;

  const cookiesB = await registerAndLogin(TEST_EMAIL_2, TEST_PASSWORD, 'User B');

  const res = await assetPatch(portfolioId, assetId, { balance: '5' }, cookiesB);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});
