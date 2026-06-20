// Neonfi backend — Analytics endpoints integration tests (Stage 14).
//
// GET /api/v1/analytics/:portfolioId/{summary,performance,holdings} — Pro-only,
// portfolio-ownership gated. Real DB + Redis; per-test cleanup. Users authenticate
// via register/login (cookie); subscriptions, portfolios, assets, snapshots, and
// transaction rows are seeded directly via Prisma. Tests 326-337.

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
const analyticsBase = (portfolioId: number) => `/api/v1/analytics/${portfolioId}`;
const txBase = (portfolioId: number) => `/api/v1/portfolios/${portfolioId}/transactions`;

const TEST_EMAIL = 'analytics.api@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

let btcId: number;
let ethId: number;

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
  fullName = 'Analytics Api',
): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function createProSub(userId: number): Promise<void> {
  const [plan, cycle, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
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

// Active FREE subscription — the only state that reaches PLAN_LIMIT_REACHED (a
// missing sub → SUBSCRIPTION_REQUIRED, an inactive one → SUBSCRIPTION_EXPIRED; see
// plan.ts:31-43 and Stage 14 §3 test 334).
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
  // retrofit-77: approx=true marks a backfilled ESTIMATE (excluded from the short-term baseline).
  opts: { approx?: boolean } = {},
): Promise<void> {
  await prisma.balanceSnapshot.create({
    data: {
      portfolioId,
      userId,
      snapshotDate: new Date(`${ymd}T00:00:00.000Z`),
      value: value.toString(),
      approx: opts.approx ?? false,
    },
  });
}

// Direct native-transaction seed with an explicit usdValue (bypasses the service so
// it does NOT touch asset balance / netDeposit — those are set independently). Used
// to drive getDepositWithdrawalTotals.
async function seedNativeTx(
  portfolioId: number,
  direction: 'buy' | 'sell',
  usdValue: number,
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
      timestamp: new Date(TIMESTAMP),
      nativeDetail: { create: { amount: '1', symbol: 'BTC', usdValue: usdValue.toString() } },
    },
  });
}

function aGet(portfolioId: number, path: string, cookies?: string): Promise<Response> {
  return app.request(`${analyticsBase(portfolioId)}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

function txPost(
  portfolioId: number,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(txBase(portfolioId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}) },
    body: JSON.stringify(body),
  });
}

// UTC-midnight calendar day, `n` days before today — matches findSnapshotNearDaysAgo.
const todayUtc = (): Date => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const ymdDaysAgo = (n: number): string =>
  new Date(todayUtc().getTime() - n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Setup — clear hypertable first (cascade-truncate then only hits empty table)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
});

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
  await clearRedisAuthKeys();
  await redis.del('price:BTC'); // keep computeUsdValue hermetic on the DB-seeded price
});

afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

// ---------------------------------------------------------------------------
// 326-328 — GET /summary
// ---------------------------------------------------------------------------

it('326: GET /summary happy path — all 9 fields populated with correct values', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P', 80000);
  await seedAsset(portfolioId, btcId, 1.0); // totalValue = 93000
  await seedNativeTx(portfolioId, 'buy', 80000);
  await seedNativeTx(portfolioId, 'sell', 5000);
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(7), 85000);
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(30), 70000);

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);

  const json = (await res.json()) as { data: Record<string, number> };
  const d = json.data;

  expect(Object.keys(d).sort()).toEqual(
    [
      'portfolioId',
      'allTimePnlPct',
      'allTimePnlValue',
      'totalDeposits',
      'totalWithdrawals',
      'pnl7d',
      'pnl7dValue',
      'pnl30d',
      'pnl30dValue',
    ].sort(),
  );
  expect(d.portfolioId).toBe(portfolioId);
  expect(d.allTimePnlValue).toBeCloseTo(13000, 2); // 93000 − 80000
  expect(d.allTimePnlPct).toBeCloseTo(16.25, 2); // (13000/80000)*100
  expect(d.totalDeposits).toBeCloseTo(80000, 2);
  expect(d.totalWithdrawals).toBeCloseTo(5000, 2);
  expect(d.pnl7dValue).toBeCloseTo(8000, 2); // 93000 − 85000
  expect(d.pnl7d).toBe(9.41); // (8000/85000)*100 = 9.41176… → 2dp on the wire (retrofit-4)
  expect(d.pnl30dValue).toBeCloseTo(23000, 2); // 93000 − 70000
  expect(d.pnl30d).toBe(32.86); // (23000/70000)*100 = 32.85714… → 2dp (retrofit-4)
});

it('327: GET /summary with no historical snapshots → pnl7d/30d fields all 0, allTime still populated', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P', 80000);
  await seedAsset(portfolioId, btcId, 1.0);

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number> }).data;

  expect(d.pnl7d).toBe(0);
  expect(d.pnl7dValue).toBe(0);
  expect(d.pnl30d).toBe(0);
  expect(d.pnl30dValue).toBe(0);
  expect(d.allTimePnlValue).toBeCloseTo(13000, 2);
  expect(d.allTimePnlPct).toBeCloseTo(16.25, 2);
});

it('328: GET /summary with netDeposit=0 → allTimePnlPct=0, allTimePnlValue equals totalValue', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P'); // netDeposit defaults to 0
  await seedAsset(portfolioId, btcId, 1.0); // totalValue = 93000

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number> }).data;

  expect(d.allTimePnlPct).toBe(0); // divide-by-zero guard
  expect(d.allTimePnlValue).toBeCloseTo(93000, 2); // equals current totalValue
});

it('r72-connected: GET /summary on a connected portfolio → totalDeposits/totalWithdrawals null (no reliable ledger)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);

  // Connected portfolio with imported transfers (which would otherwise sum to misleading totals).
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } });
  const p = await prisma.portfolio.create({
    data: { userId, name: 'Connected', typeId: type.id, walletAddress: '0xabc' },
  });
  await seedAsset(p.id, btcId, 1.0);
  await seedNativeTx(p.id, 'buy', 100);
  await seedNativeTx(p.id, 'sell', 500); // one-directional import → $100 in vs $500 out

  const res = await aGet(p.id, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number | null> }).data;

  // retrofit-72 (H9/R37): connected → "—" deposits/withdrawals, never $100 vs $500.
  expect(d.totalDeposits).toBeNull();
  expect(d.totalWithdrawals).toBeNull();
  // The all-time numbers are still present (snapshot-derived for connected).
  expect(typeof d.allTimePnlValue).toBe('number');
});

it('r72-tolerance: a snapshot far older than the window is NOT used as that window\'s baseline', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P');
  await seedAsset(portfolioId, btcId, 1.0); // totalValue = 93000
  await redis.del('price:BTC');

  // A 12-day-old snapshot is the nearest at-or-before the 7d cutoff (today-7), but it's 5 days
  // older than the target → rejected by the H5 tolerance → pnl7d = 0 ("—"). A snapshot exactly
  // 30 days old is within the looser 30d tolerance → pnl30d is real.
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(12), 60000);
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(30), 70000);

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number> }).data;

  expect(d.pnl7d).toBe(0); // 12-day-old baseline rejected for the 7d window
  expect(d.pnl7dValue).toBe(0);
  expect(d.pnl30dValue).toBeCloseTo(23000, 2); // 93000 − 70000 (30d snapshot accepted)
  expect(d.pnl30d).toBe(32.86);
});

it('r77-approx: a backfilled (approx) snapshot is NOT used as the short-term baseline (pnl7d=0); a real one is (pnl30d)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P');
  await seedAsset(portfolioId, btcId, 1.0); // totalValue = 93000
  await redis.del('price:BTC');

  // retrofit-77: identical setup to the happy path (7d→85000, 30d→70000) EXCEPT the 7d snapshot is
  // an APPROXIMATE backfill (connected initial-sync estimate). The short-term baseline must ignore
  // it → pnl7d = 0 ("—"), even though it's within the H5 tolerance and would otherwise give +8000.
  // The 30d snapshot is REAL → pnl30d is the true delta, proving it's the approx flag (not absence
  // of data) that suppresses 7d.
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(7), 85000, { approx: true });
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(30), 70000); // real

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number> }).data;

  expect(d.pnl7d).toBe(0); // approx baseline ignored
  expect(d.pnl7dValue).toBe(0);
  expect(d.pnl30dValue).toBeCloseTo(23000, 2); // 93000 − 70000 (real 30d snapshot accepted)
  expect(d.pnl30d).toBe(32.86);
});

// ---------------------------------------------------------------------------
// 329-330 — GET /performance
// ---------------------------------------------------------------------------

it('329: GET /performance happy path — snapshots ASC by date, each { date, value }', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);
  // Seed out of order; endpoint must return ASC
  await seedSnapshot(portfolioId, userId, '2026-06-12', 120);
  await seedSnapshot(portfolioId, userId, '2026-06-10', 100);
  await seedSnapshot(portfolioId, userId, '2026-06-11', 110);

  const res = await aGet(portfolioId, '/performance', cookies);
  expect(res.status).toBe(200);

  const json = (await res.json()) as {
    data: { portfolioId: number; snapshots: Array<{ date: string; value: number }> };
  };
  expect(json.data.portfolioId).toBe(portfolioId);
  expect(json.data.snapshots.map((s) => s.date)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  expect(json.data.snapshots.map((s) => s.value)).toEqual([100, 110, 120]);
  // Each item has exactly { date, value }
  for (const s of json.data.snapshots) {
    expect(Object.keys(s).sort()).toEqual(['date', 'value'].sort());
    expect(typeof s.value).toBe('number');
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

it('330: GET /performance on portfolio with no snapshots → 200, empty snapshots array', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await aGet(portfolioId, '/performance', cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { snapshots: unknown[] } };
  expect(json.data.snapshots).toEqual([]);
});

// ---------------------------------------------------------------------------
// 331-333 — GET /holdings
// ---------------------------------------------------------------------------

it('331: GET /holdings happy path — assets DESC by value, correct percentages, exact shape', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0); // value 93000
  await seedAsset(portfolioId, ethId, 2.0); // value 6400

  const res = await aGet(portfolioId, '/holdings', cookies);
  expect(res.status).toBe(200);

  const json = (await res.json()) as {
    data: {
      portfolioId: number;
      assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
    };
  };
  const assets = json.data.assets;

  expect(json.data.portfolioId).toBe(portfolioId);
  expect(assets.map((a) => a.symbol)).toEqual(['BTC', 'ETH']); // DESC by value
  expect(assets[0]!.value).toBeCloseTo(93000, 2);
  expect(assets[1]!.value).toBeCloseTo(6400, 2);
  expect(assets[0]!.portfolioPercentage).toBe(93.56); // 93000/99400*100 = 93.56136… → 2dp (retrofit-4)
  expect(assets[1]!.portfolioPercentage).toBe(6.44); // 6400/99400*100 = 6.44080… → 2dp (retrofit-4)
  for (const a of assets) {
    expect(Object.keys(a).sort()).toEqual(['portfolioPercentage', 'symbol', 'value'].sort());
  }
});

it('332: GET /holdings filters zero-balance assets', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 0); // zero balance — must be filtered out

  const res = await aGet(portfolioId, '/holdings', cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { assets: Array<{ symbol: string }> } };
  expect(json.data.assets).toHaveLength(1);
  expect(json.data.assets[0]!.symbol).toBe('BTC');
});

it('333: GET /holdings on empty portfolio → 200, empty assets array', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await aGet(portfolioId, '/holdings', cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { assets: unknown[] } };
  expect(json.data.assets).toEqual([]);
});

// ---------------------------------------------------------------------------
// 334-335 — auth / ownership gates
// ---------------------------------------------------------------------------

it('334: all 3 endpoints as Free user → 403 PLAN_LIMIT_REACHED', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSub(userId); // active free subscription
  const portfolioId = await createManualPortfolio(userId);

  for (const path of ['/summary', '/performance', '/holdings']) {
    const res = await aGet(portfolioId, path, cookies);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
  }
});

it("335: all 3 endpoints on another user's portfolio → 403 FORBIDDEN", async () => {
  // Requesting user (Pro)
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);

  // Other user (Pro) owns the portfolio
  await registerAndLogin('analytics.api.other@neonfi.test', TEST_PASSWORD, 'Other');
  const otherId = await getUserId('analytics.api.other@neonfi.test');
  await createProSub(otherId);
  const othersPortfolio = await createManualPortfolio(otherId);

  for (const path of ['/summary', '/performance', '/holdings']) {
    const res = await aGet(othersPortfolio, path, cookies);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
  }
});

// ---------------------------------------------------------------------------
// 336-337 — cache behaviour
// ---------------------------------------------------------------------------

it('336: cache HIT on /summary — pre-populated analytics_summary:<id> is returned without recompute', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId); // empty → a real compute would NOT yield 99999

  const sentinel = {
    portfolioId,
    allTimePnlPct: 12.34,
    allTimePnlValue: 99999,
    totalDeposits: 1,
    totalWithdrawals: 2,
    pnl7d: 3,
    pnl7dValue: 4,
    pnl30d: 5,
    pnl30dValue: 6,
  };
  await redis.set(`analytics_summary:${portfolioId}`, JSON.stringify(sentinel), 'EX', 300);

  const res = await aGet(portfolioId, '/summary', cookies);
  expect(res.status).toBe(200);
  const d = ((await res.json()) as { data: Record<string, number> }).data;
  expect(d.allTimePnlValue).toBe(99999); // sentinel returned verbatim, no recompute
});

it('337: cache invalidation end-to-end — POST transaction evicts analytics_summary:<id>', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 0); // asset must exist for the manual tx POST

  // 1. GET /summary populates the cache
  const first = await aGet(portfolioId, '/summary', cookies);
  expect(first.status).toBe(200);
  expect(await redis.exists(`analytics_summary:${portfolioId}`)).toBe(1);

  // 2. POST a manual transaction → invalidatePnlCache deletes the derived-cache set
  const post = await txPost(
    portfolioId,
    { type: 'native', direction: 'buy', amount: '0.5', symbol: 'BTC', timestamp: TIMESTAMP },
    cookies,
  );
  expect(post.status).toBe(201);

  // 3. analytics_summary key is gone — proves portfolioDerivedCacheKeys wiring
  expect(await redis.exists(`analytics_summary:${portfolioId}`)).toBe(0);
});

// ---------------------------------------------------------------------------
// 338 — retrofit-4: numeric outputs are rounded to 2dp on the wire
// ---------------------------------------------------------------------------

it('338: rounding is applied — equal-value holdings each 33.33 exactly, summary pct at 2dp', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const usdtId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } })).id;

  // Three assets of EQUAL USD value (9300 each): BTC 0.1×93000, ETH 2.90625×3200,
  // USDT 9300×1. totalValue = 27900 → each share = 9300/27900 = 33.3333…% which the
  // round helper must clamp to exactly 33.33 (a raw float would be 33.33333…).
  const portfolioId = await createManualPortfolio(userId, 'P', 27900);
  await seedAsset(portfolioId, btcId, 0.1);
  await seedAsset(portfolioId, ethId, 2.90625);
  await seedAsset(portfolioId, usdtId, 9300);

  const holdings = await aGet(portfolioId, '/holdings', cookies);
  expect(holdings.status).toBe(200);
  const hd = (
    (await holdings.json()) as {
      data: { assets: Array<{ symbol: string; value: number; portfolioPercentage: number }> };
    }
  ).data;

  expect(hd.assets).toHaveLength(3);
  for (const a of hd.assets) {
    expect(a.portfolioPercentage).toBe(33.33); // exact 2dp — proves round() is wired
    expect(a.value).toBe(9300);
  }

  // Summary: seed a 7d-ago snapshot of 27000 → pnl7d = (900/27000)*100 = 3.3333…%,
  // which must land on the wire as exactly 3.33 (its own 2dp-rounded value).
  await seedSnapshot(portfolioId, userId, ymdDaysAgo(7), 27000);
  const summary = await aGet(portfolioId, '/summary', cookies);
  expect(summary.status).toBe(200);
  const sd = ((await summary.json()) as { data: Record<string, number> }).data;
  expect(sd.pnl7d).toBe(3.33);
});
