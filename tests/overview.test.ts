// Neonfi backend — Overview endpoint integration tests (retrofit-13).
//
// GET /api/v1/overview — the dashboard cross-portfolio aggregate. requireAuth ONLY
// (NOT Pro-gated): free users must get 200. Real DB + Redis; per-test cleanup. Users
// authenticate via register/login (cookie); subscriptions, portfolios, assets,
// snapshots, and transaction rows are seeded directly via Prisma. Tests 371-378.

import { it, beforeAll, beforeEach, afterAll, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock — register/login send mails we don't exercise here
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
const OVERVIEW_BASE = '/api/v1/overview';

const TEST_EMAIL = 'overview.api@neonfi.test';
const TEST_PASSWORD = 'Test1234';

// DB-seeded token prices (see analytics.test.ts): BTC 93000, ETH 3200, USDT 1.
let btcId: number;
let ethId: number;
let usdtId: number;

interface OverviewData {
  totals: {
    totalValue: number;
    pnl24h: number;
    pnl24hValue: number;
    pnlAllTime: number;
    pnlAllTimeValue: number;
    portfolioCount: number;
    transactionCount: number;
  };
  portfolios: Array<{
    id: number;
    name: string;
    slug: string;
    type: string;
    chainId: number | null;
    chainName: string | null;
    assetCount: number;
    totalValue: number;
    pnl24h: number;
    pnl24hValue: number;
    pnlAllTime: number;
    pnlAllTimeValue: number;
  }>;
  valueHistory: Array<{ date: string; value: number }>;
  allocation: Array<{ symbol: string; value: number; percentage: number }>;
  holdings: Array<{ symbol: string; balance: number }>;
  recentTransactions: Array<{ id: number; portfolioId: number; timestamp: string }>;
}

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
  fullName = 'Overview Api',
): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

// Active FREE subscription — proves the endpoint is plan-agnostic (a free user must
// get 200, not 403). Mirrors analytics.test.ts:createFreeSub.
async function createFreeSub(userId: number): Promise<void> {
  const [plan, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
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

async function createManualPortfolio(
  userId: number,
  name = 'P',
  netDeposit?: number,
): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const p = await prisma.portfolio.create({
    data: {
      userId,
      name,
      typeId: type.id,
      ...(netDeposit !== undefined ? { netDeposit: netDeposit.toString() } : {}),
    },
  });
  return p.id;
}

async function seedAsset(portfolioId: number, tokenId: number, balance: number): Promise<void> {
  await prisma.asset.create({
    data: { portfolioId, tokenId, balance: balance.toString() },
  });
}

async function seedSnapshot(
  portfolioId: number,
  userId: number,
  ymd: string,
  value: number,
): Promise<void> {
  await prisma.balanceSnapshot.create({
    data: {
      portfolioId,
      userId,
      snapshotDate: new Date(`${ymd}T00:00:00.000Z`),
      value: value.toString(),
    },
  });
}

// Direct native-transaction seed with an explicit timestamp + usdValue (bypasses the
// service so it does NOT touch asset balance / netDeposit). Drives the recent-tx tests.
async function seedNativeTx(
  portfolioId: number,
  timestamp: string,
  direction: 'buy' | 'sell' = 'buy',
  usdValue = 100,
): Promise<void> {
  const [typeRow, dirRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: direction } }),
  ]);
  await prisma.transaction.create({
    data: {
      portfolioId,
      typeId: typeRow.id,
      directionId: dirRow.id,
      timestamp: new Date(timestamp),
      nativeDetail: { create: { amount: '1', symbol: 'BTC', usdValue: usdValue.toString() } },
    },
  });
}

function overviewGet(cookies?: string, query = ''): Promise<Response> {
  return app.request(`${OVERVIEW_BASE}${query}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function getData(res: Response): Promise<OverviewData> {
  return ((await res.json()) as { data: OverviewData }).data;
}

// ---------------------------------------------------------------------------
// Setup — clear hypertable first (cascade-truncate then only hits empty table)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
  usdtId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } })).id;
});

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
  await clearRedisAuthKeys();
  // truncateAllUserData flushes portfolio_pnl/analytics caches but not overview:* —
  // user/portfolio IDs repeat across tests (TRUNCATE resets sequences), so a stale
  // overview payload from a prior test must be flushed here.
  const overviewKeys = await redis.keys('overview:*');
  if (overviewKeys.length > 0) await redis.del(overviewKeys);
});

afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

// ---------------------------------------------------------------------------
// 371 — empty user
// ---------------------------------------------------------------------------

it('371: empty user (no portfolios) → 200, all totals 0, all arrays empty (NOT 404)', async () => {
  const cookies = await registerAndLogin();

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  expect(d.totals).toEqual({
    totalValue: 0,
    pnl24h: 0,
    pnl24hValue: 0,
    pnlAllTime: 0,
    pnlAllTimeValue: 0,
    portfolioCount: 0,
    transactionCount: 0,
  });
  expect(d.portfolios).toEqual([]);
  expect(d.valueHistory).toEqual([]);
  expect(d.allocation).toEqual([]);
  expect(d.holdings).toEqual([]);
  expect(d.recentTransactions).toEqual([]);
});

// ---------------------------------------------------------------------------
// 372 — aggregation across two portfolios with an overlapping symbol
// ---------------------------------------------------------------------------

it('372: aggregates totals, merges allocation/holdings by symbol, per-portfolio assetCount', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // P1: BTC 1.0 (93000) + ETH 2.0 (6400) → totalValue 99400, netDeposit 80000
  // P2: BTC 0.5 (46500) + USDT 1000 (1000) → totalValue 47500, netDeposit 40000
  const p1 = await createManualPortfolio(userId, 'P1', 80000);
  const p2 = await createManualPortfolio(userId, 'P2', 40000);
  await seedAsset(p1, btcId, 1.0);
  await seedAsset(p1, ethId, 2.0);
  await seedAsset(p2, btcId, 0.5);
  await seedAsset(p2, usdtId, 1000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // totals
  expect(d.totals.totalValue).toBeCloseTo(146900, 2); // 99400 + 47500
  expect(d.totals.portfolioCount).toBe(2);
  expect(d.totals.pnlAllTimeValue).toBeCloseTo(26900, 2); // 19400 + 7500
  expect(d.totals.pnlAllTime).toBe(22.42); // 26900 / (146900-26900) * 100 = 22.4166… → 2dp
  expect(d.totals.pnl24h).toBe(0); // derive.ts has no 24h source yet
  expect(d.totals.pnl24hValue).toBe(0);

  // allocation — merged, desc by value, % of grand total (146900)
  expect(d.allocation.map((a) => a.symbol)).toEqual(['BTC', 'ETH', 'USDT']);
  const btc = d.allocation.find((a) => a.symbol === 'BTC')!;
  expect(btc.value).toBeCloseTo(139500, 2); // 93000 + 46500 (merged)
  expect(btc.percentage).toBe(94.96); // 139500/146900*100 = 94.9625… → 2dp
  expect(d.allocation.find((a) => a.symbol === 'ETH')!.percentage).toBe(4.36);
  expect(d.allocation.find((a) => a.symbol === 'USDT')!.percentage).toBe(0.68);

  // holdings — merged raw balances per symbol
  const hbBtc = d.holdings.find((h) => h.symbol === 'BTC')!;
  expect(hbBtc.balance).toBeCloseTo(1.5, 8); // 1.0 + 0.5 (merged)
  expect(d.holdings.find((h) => h.symbol === 'ETH')!.balance).toBeCloseTo(2.0, 8);
  expect(d.holdings.find((h) => h.symbol === 'USDT')!.balance).toBeCloseTo(1000, 8);

  // per-portfolio rows
  const r1 = d.portfolios.find((p) => p.name === 'P1')!;
  const r2 = d.portfolios.find((p) => p.name === 'P2')!;
  expect(r1.assetCount).toBe(2);
  expect(r2.assetCount).toBe(2);
  expect(r1.slug).toBe('p1');
  expect(r1.type).toBe('manual');
  expect(r1.chainId).toBeNull();
  expect(r1.chainName).toBeNull();
  expect(r1.totalValue).toBeCloseTo(99400, 2);
  expect(r1.pnlAllTimeValue).toBeCloseTo(19400, 2); // 99400 - 80000
  expect(r2.totalValue).toBeCloseTo(47500, 2);
  expect(r2.pnlAllTimeValue).toBeCloseTo(7500, 2); // 47500 - 40000
});

// ---------------------------------------------------------------------------
// 373 — value-history forward-fill (aggregate chart)
// ---------------------------------------------------------------------------

it('373: valueHistory forward-fills each portfolio across the union of snapshot dates', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  // P1 has snapshots on 06-10 and 06-12; P2 only on 06-11.
  await seedSnapshot(p1, userId, '2026-06-10', 100);
  await seedSnapshot(p1, userId, '2026-06-12', 120);
  await seedSnapshot(p2, userId, '2026-06-11', 50);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Union dates asc: 06-10, 06-11, 06-12.
  // 06-10: P1=100, P2 has no snapshot on/before → 0           => 100
  // 06-11: P1 forward-fills its 06-10 value (100), P2=50      => 150
  // 06-12: P1=120, P2 forward-fills its 06-11 value (50)      => 170
  expect(d.valueHistory).toEqual([
    { date: '2026-06-10', value: 100 },
    { date: '2026-06-11', value: 150 },
    { date: '2026-06-12', value: 170 },
  ]);
});

// ---------------------------------------------------------------------------
// 374 — days window clamps the chart to the last N dates
// ---------------------------------------------------------------------------

it('374: ?days=2 keeps only the last two snapshot dates (forward-fill preserved)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  await seedSnapshot(p1, userId, '2026-06-10', 100);
  await seedSnapshot(p1, userId, '2026-06-12', 120);
  await seedSnapshot(p2, userId, '2026-06-11', 50);

  const res = await overviewGet(cookies, '?days=2');
  expect(res.status).toBe(200);
  const d = await getData(res);

  expect(d.valueHistory).toEqual([
    { date: '2026-06-11', value: 150 },
    { date: '2026-06-12', value: 170 },
  ]);
});

// ---------------------------------------------------------------------------
// 375 — recent transactions + count (cross-portfolio)
// ---------------------------------------------------------------------------

it('375: recentTransactions = most recent txLimit across all portfolios (desc); count = total', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  // Interleave timestamps across the two portfolios.
  await seedNativeTx(p1, '2026-01-01T00:00:00.000Z');
  await seedNativeTx(p2, '2026-01-02T00:00:00.000Z');
  await seedNativeTx(p1, '2026-01-03T00:00:00.000Z');
  await seedNativeTx(p2, '2026-01-04T00:00:00.000Z');

  const res = await overviewGet(cookies, '?txLimit=2');
  expect(res.status).toBe(200);
  const d = await getData(res);

  // count spans BOTH portfolios and ignores txLimit
  expect(d.totals.transactionCount).toBe(4);
  // list = the 2 most recent across both, desc by timestamp
  expect(d.recentTransactions).toHaveLength(2);
  expect(d.recentTransactions[0]!.timestamp).toBe('2026-01-04T00:00:00.000Z');
  expect(d.recentTransactions[0]!.portfolioId).toBe(p2);
  expect(d.recentTransactions[1]!.timestamp).toBe('2026-01-03T00:00:00.000Z');
  expect(d.recentTransactions[1]!.portfolioId).toBe(p1);
});

// ---------------------------------------------------------------------------
// 376 — plan-agnostic: a free user gets 200 (NOT 403)
// ---------------------------------------------------------------------------

it('376: free user with an active free subscription → 200 (not Pro-gated)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSub(userId); // active free subscription
  const p = await createManualPortfolio(userId, 'P', 0);
  await seedAsset(p, btcId, 1.0);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);
  expect(d.totals.totalValue).toBeCloseTo(93000, 2);
  expect(d.totals.portfolioCount).toBe(1);
});

// ---------------------------------------------------------------------------
// 377 — ownership: a user never sees another user's data
// ---------------------------------------------------------------------------

it("377: a second user's overview excludes the first user's portfolios/data", async () => {
  // User A owns a portfolio with a BTC holding.
  const cookiesA = await registerAndLogin('overview.a@neonfi.test', TEST_PASSWORD, 'A');
  const userA = await getUserId('overview.a@neonfi.test');
  const pA = await createManualPortfolio(userA, 'A-Port');
  await seedAsset(pA, btcId, 1.0);
  await seedNativeTx(pA, '2026-01-01T00:00:00.000Z');

  // User B owns nothing.
  const cookiesB = await registerAndLogin('overview.b@neonfi.test', TEST_PASSWORD, 'B');

  const res = await overviewGet(cookiesB);
  expect(res.status).toBe(200);
  const d = await getData(res);
  expect(d.totals.totalValue).toBe(0);
  expect(d.totals.transactionCount).toBe(0);
  expect(d.portfolios).toEqual([]);
  expect(d.recentTransactions).toEqual([]);

  // Sanity: user A DOES see their own data (ownership filter is real, not blanket-empty).
  const resA = await overviewGet(cookiesA);
  const dA = await getData(resA);
  expect(dA.totals.totalValue).toBeCloseTo(93000, 2);
  expect(dA.portfolios.map((p) => p.name)).toEqual(['A-Port']);
});

// ---------------------------------------------------------------------------
// 378 — auth: no session → 401
// ---------------------------------------------------------------------------

it('378: no session cookie → 401', async () => {
  const res = await overviewGet();
  expect(res.status).toBe(401);
});
