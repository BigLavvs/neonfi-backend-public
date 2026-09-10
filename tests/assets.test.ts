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
