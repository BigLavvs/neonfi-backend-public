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
    pnlAllTime: number | null; // retrofit-80: null ("—") when no valid base
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
    inceptionDate: string; // retrofit-66
    assetCount: number;
    totalValue: number;
    pnl24h: number | null;
    pnl24hValue: number | null;
    pnlAllTime: number | null; // retrofit-79/80: null ("—") for connected (no lifetime base)
    pnlAllTimeValue: number | null;
    // retrofit-28: raw per-portfolio position data for client recompute.
    holdings: Array<{
      symbol: string;
      balance: number;
      avgCost: number | null;
      costBasis: number;
      realizedPnl: number;
    }>;
  }>;
  valueHistory: Array<{ date: string; value: number; approx: boolean }>; // retrofit-81: per-point provenance
  connectedValueHistory: Array<{ date: string; value: number; approx: boolean }>; // retrofit-56 + retrofit-81
  allocation: Array<{ symbol: string; value: number; percentage: number }>;
  // retrofit-28: aggregate holdings carry cost fields too.
  holdings: Array<{
    symbol: string;
    balance: number;
    avgCost: number | null;
    costBasis: number;
    realizedPnl: number;
  }>;
  recentTransactions: Array<{ id: number; portfolioId: number; timestamp: string }>;
  topMovers: Array<{ symbol: string; name: string; change24h: number; spark: number[] }>;
}

// retrofit-18: write a canonical live price tick (mirrors the resolver payload). Pass
// change24h:null to write a tick with NO change24h field (the "missing" skip path).
async function seedPriceTick(
  symbol: string,
  change24h: number | null,
  price = 100,
): Promise<void> {
  const payload =
    change24h === null
      ? JSON.stringify({ price, source: 'coinbase', ts: 1700000000000 })
      : JSON.stringify({ price, change24h, source: 'coinbase', ts: 1700000000000 });
  await redis.set(`price:${symbol}`, payload, 'EX', 60);
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

// retrofit-56: a connected portfolio (needs a chain FK + walletAddress for type='connected').
// retrofit-74: walletAddress is parameterized so the dedupe test can give two portfolios the
// SAME wallet (externalTxCount counted once) vs DIFFERENT wallets (counted per portfolio).
async function createConnectedPortfolio(
  userId: number,
  name = 'C',
  walletAddress = `0x${'a'.repeat(40)}`,
): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } });
  const chain = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const p = await prisma.portfolio.create({
    data: {
      userId,
      name,
      typeId: type.id,
      chainId: chain.id,
      walletAddress,
    },
  });
  return p.id;
}

async function seedAsset(portfolioId: number, tokenId: number, balance: number): Promise<void> {
  await prisma.asset.create({
    data: { portfolioId, tokenId, balance: balance.toString() },
  });
}

// retrofit-28: seed an asset with the recalc-maintained cost fields set directly, so the
// holdings[] assertions exercise the raw position data the /overview now exposes.
// avgCost null = cost-unknown holding (excluded from aggregate avgCost).
async function seedAssetWithCost(
  portfolioId: number,
  tokenId: number,
  balance: number,
  opts: { avgCost?: number | null; costBasis?: number; realizedPnl?: number } = {},
): Promise<void> {
  await prisma.asset.create({
    data: {
      portfolioId,
      tokenId,
      balance: balance.toString(),
      ...(opts.avgCost != null ? { avgCost: opts.avgCost.toString() } : {}),
      costBasis: (opts.costBasis ?? 0).toString(),
      realizedPnl: (opts.realizedPnl ?? 0).toString(),
    },
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
  // retrofit-18: topMovers is a single GLOBAL cache key (not per-user) — flush it too so
  // each test computes fresh from the ticks it seeds (truncateAllUserData clears price:*).
  await redis.del('overview_top_movers');
  // retrofit-20: price_hist:<SYMBOL> sparkline lists (read by computeTopMovers, seeded
  // directly by the spark gate) — flush so a series can't bleed across tests.
  const histKeys = await redis.keys('price_hist:*');
  if (histKeys.length > 0) await redis.del(histKeys);
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
    // retrofit-27 average-cost aggregate fields (additive)
    unrealizedPnlValue: 0,
    unrealizedPnlPct: 0,
    realizedPnlValue: 0,
    allTimePnlValue: 0,
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
  // retrofit-75 (R39): canonical all-time for a MANUAL portfolio is cost-basis
  // (unrealized+realized), which excludes cost-unknown holdings. These assets are seeded
  // with no avgCost (cost-unknown), so the honest all-time is 0 — NOT the old netDeposit
  // phantom (totalValue − netDeposit = +26900). A cost-unknown opening no longer reads as gain.
  expect(d.totals.pnlAllTimeValue).toBe(0);
  expect(d.totals.pnlAllTime).toBe(0);
  expect(d.totals.pnl24h).toBe(0); // retrofit-20: no snapshot ≥24h old → 0/0 baseline
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
  // retrofit-75 (R39): per-portfolio all-time is the canonical cost-basis number for manual.
  // Cost-unknown holdings (no avgCost seeded) → 0, replacing the netDeposit-based 19400/7500.
  expect(r1.pnlAllTimeValue).toBe(0);
  expect(r2.totalValue).toBeCloseTo(47500, 2);
  expect(r2.pnlAllTimeValue).toBe(0);
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
    { date: '2026-06-10', value: 100, approx: false },
    { date: '2026-06-11', value: 150, approx: false },
    { date: '2026-06-12', value: 170, approx: false },
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
    { date: '2026-06-11', value: 150, approx: false },
    { date: '2026-06-12', value: 170, approx: false },
  ]);
});

// ---------------------------------------------------------------------------
// retrofit-56 — connectedValueHistory is the connected-only slice of the snapshot series
// ---------------------------------------------------------------------------

it('r56: connectedValueHistory contains only connected portfolios; valueHistory still spans all', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const manual = await createManualPortfolio(userId, 'Manual');
  const connected = await createConnectedPortfolio(userId, 'Connected');
  // Manual on 06-10 (100); connected on 06-10 (30) and 06-11 (40).
  await seedSnapshot(manual, userId, '2026-06-10', 100);
  await seedSnapshot(connected, userId, '2026-06-10', 30);
  await seedSnapshot(connected, userId, '2026-06-11', 40);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Aggregate (all): 06-10 = 100 + 30 = 130; 06-11 = manual fwd-fill 100 + connected 40 = 140.
  expect(d.valueHistory).toEqual([
    { date: '2026-06-10', value: 130, approx: false },
    { date: '2026-06-11', value: 140, approx: false },
  ]);
  // Connected-only: 06-10 = 30; 06-11 = 40. The manual portfolio contributes nothing here.
  expect(d.connectedValueHistory).toEqual([
    { date: '2026-06-10', value: 30, approx: false },
    { date: '2026-06-11', value: 40, approx: false },
  ]);
});

it('r56: connectedValueHistory is [] when the user has only manual portfolios', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const manual = await createManualPortfolio(userId, 'Manual');
  await seedSnapshot(manual, userId, '2026-06-10', 100);

  const res = await overviewGet(cookies);
  const d = await getData(res);
  expect(d.valueHistory).toEqual([{ date: '2026-06-10', value: 100, approx: false }]);
  expect(d.connectedValueHistory).toEqual([]);
});

// ---------------------------------------------------------------------------
// retrofit-81 — value-history KEEPS the backfilled (approx) timeline and flags it, instead of
// retrofit-79 §3's filter that DELETED the connected wallet's entire multi-year history.
// ---------------------------------------------------------------------------

it('r81: value-history retains approx backfill points (full timeline) and flags them per-point; real points stay approx=false', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connected = await createConnectedPortfolio(userId, 'Connected');
  // Two old backfilled ESTIMATE points (the multi-year history retrofit-79 §3 wrongly dropped),
  // then a recent REAL daily observation. retrofit-81 must serve ALL three, tagging provenance.
  await seedSnapshot(connected, userId, '2024-01-01', 200, { approx: true });
  await seedSnapshot(connected, userId, '2024-06-01', 150, { approx: true });
  await seedSnapshot(connected, userId, '2026-06-19', 12, { approx: false });

  const res = await overviewGet(cookies, '?days=1095');
  expect(res.status).toBe(200);
  const d = await getData(res);

  // The full span is present (NOT collapsed to the single real point), each carrying `approx`.
  expect(d.valueHistory).toEqual([
    { date: '2024-01-01', value: 200, approx: true },
    { date: '2024-06-01', value: 150, approx: true },
    { date: '2026-06-19', value: 12, approx: false },
  ]);
  expect(d.connectedValueHistory).toEqual([
    { date: '2024-01-01', value: 200, approx: true },
    { date: '2024-06-01', value: 150, approx: true },
    { date: '2026-06-19', value: 12, approx: false },
  ]);
});

it('r81: a manual portfolio aggregated with a connected one only taints the dates it estimates; a real sibling snapshot keeps that date approx=false', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connected = await createConnectedPortfolio(userId, 'Connected');
  const manual = await createManualPortfolio(userId, 'Manual');
  // Connected: an approx point on 06-10, then a real point on 06-12.
  await seedSnapshot(connected, userId, '2026-06-10', 200, { approx: true });
  await seedSnapshot(connected, userId, '2026-06-12', 100, { approx: false });
  // Manual: a real point on 06-11 only (forward-fills onward); always approx=false.
  await seedSnapshot(manual, userId, '2026-06-11', 50, { approx: false });

  const res = await overviewGet(cookies, '?days=1095');
  expect(res.status).toBe(200);
  const d = await getData(res);

  // 06-10: connected approx 200 (manual no snapshot yet → 0, doesn't taint)          => 200 approx
  // 06-11: connected fwd-fills its approx 200 + manual real 50                         => 250 approx
  // 06-12: connected real 100 + manual fwd-fills real 50 (no approx contributor left)  => 150 real
  expect(d.valueHistory).toEqual([
    { date: '2026-06-10', value: 200, approx: true },
    { date: '2026-06-11', value: 250, approx: true },
    { date: '2026-06-12', value: 150, approx: false },
  ]);
});

// ---------------------------------------------------------------------------
// retrofit-79 (§1c/§4) — connected PnL is the REAL cost-basis path (provider cost basis),
// NOT the snapshot-delta retrofit-58 used (which conflated withdrawals with losses).
// ---------------------------------------------------------------------------

it('r79: connected portfolio WITH provider cost basis → cost-basis all-time (unrealized+realized), not snapshot deltas', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connId = await createConnectedPortfolio(userId, 'Conn');

  // Provider cost basis written into the Asset (as wallet-data/sync now does): avgCost 50000,
  // costBasis 50000, realizedPnl 999. BTC seeded price 93000 → totalValue 93000.
  await seedAssetWithCost(connId, btcId, 1.0, { avgCost: 50000, costBasis: 50000, realizedPnl: 999 });

  const daysAgoYmd = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  // A ~1d-ago snapshot is the 24h baseline (short-term still comes from snapshots).
  await seedSnapshot(connId, userId, daysAgoYmd(40), 40000);
  await seedSnapshot(connId, userId, daysAgoYmd(2), 80000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const row = d.portfolios.find((p) => p.name === 'Conn')!;
  expect(row.type).toBe('connected');
  expect(row.totalValue).toBeCloseTo(93000, 2);
  // Cost-basis PnL (the SAME path manual uses): unrealized = 1×(93000−50000)=43000; realized=999.
  expect(row.unrealizedPnlValue).toBeCloseTo(43000, 2);
  expect(row.realizedPnlValue).toBeCloseTo(999, 2);
  expect(row.allTimePnlValue).toBeCloseTo(43999, 2);
  // Canonical all-time VALUE = cost-basis unrealized+realized (43999), NOT the snapshot-delta 53000.
  expect(row.pnlAllTimeValue).toBeCloseTo(43999, 2);
  // retrofit-80: the connected all-time PERCENT is null ("—") — the value includes realized (43999)
  // but we have no lifetime cost base to divide by, so the old +86% (unrealized/current-cost-basis)
  // was sign/scale-inconsistent with the value. The % sign can never contradict the value sign.
  expect(row.pnlAllTime).toBeNull();
  // 24h still comes from the snapshot nearest ~1 day ago (93000 − 80000).
  expect(row.pnl24hValue).toBeCloseTo(13000, 2);

  // Totals propagate the cost-basis VALUE (single connected portfolio); the headline % is null
  // because connected portfolios are excluded from the aggregate % (no lifetime cost base).
  expect(d.totals.unrealizedPnlValue).toBeCloseTo(43000, 2);
  expect(d.totals.realizedPnlValue).toBeCloseTo(999, 2);
  expect(d.totals.pnlAllTimeValue).toBeCloseTo(43999, 2);
  expect(d.totals.pnlAllTime).toBeNull(); // retrofit-80: connected-only → no base → "—"
  expect(d.totals.pnl24hValue).toBeCloseTo(13000, 2);
});

it('r79-§4: connected portfolio WITHOUT cost basis → all-time null ("—"), excluded from totals', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connId = await createConnectedPortfolio(userId, 'NoCost');

  // Held BTC 1.0 but NO cost basis (avgCost null, realized 0) — a transfer-acquired / provider-
  // miss wallet. BTC price 93000 → totalValue 93000.
  await seedAssetWithCost(connId, btcId, 1.0, { avgCost: null, costBasis: 0, realizedPnl: 0 });

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const row = d.portfolios.find((p) => p.name === 'NoCost')!;
  expect(row.totalValue).toBeCloseTo(93000, 2);
  // §4: all-time is genuinely unknown → null, never a fabricated number.
  expect(row.pnlAllTime).toBeNull();
  expect(row.pnlAllTimeValue).toBeNull();
  // No ~24h snapshot baseline → short-term is null too (§2/D1).
  expect(row.pnl24h).toBeNull();
  expect(row.pnl24hValue).toBeNull();
  // The null-all-time portfolio is EXCLUDED from the totals all-time value (not a phantom gain).
  expect(d.totals.pnlAllTimeValue).toBe(0);
  // retrofit-80: with no portfolio carrying a valid base in scope, the headline all-time % is null
  // ("—"), NOT a fabricated 0 (the old code divided by a zero/negative implied base).
  expect(d.totals.pnlAllTime).toBeNull();
});

// ---------------------------------------------------------------------------
// retrofit-80 — the all-time % is sign-consistent with the value and never impossible.
// (Fixes the retrofit-79 regression: +$1,391 value but −99.72% row / −101.19% headline.)
// ---------------------------------------------------------------------------

it('r80: connected with a NET LOSS all-time → negative value AND null percent (sign never contradicts)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connId = await createConnectedPortfolio(userId, 'Loss');
  // Bought BTC at 100000, now 93000 → unrealized −7000; plus a realized loss −500 → all-time −7500.
  await seedAssetWithCost(connId, btcId, 1.0, { avgCost: 100000, costBasis: 100000, realizedPnl: -500 });

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const row = d.portfolios.find((p) => p.name === 'Loss')!;
  expect(row.totalValue).toBeCloseTo(93000, 2);
  // The all-time VALUE is a real loss (−7500); the PERCENT is null ("—") — no lifetime cost base.
  // The key guard: a NEGATIVE value is never paired with a POSITIVE percent (and vice-versa).
  expect(row.pnlAllTimeValue).toBeCloseTo(-7500, 2);
  expect(row.pnlAllTime).toBeNull();
  // Headline mirrors it: negative value, null percent — never a fabricated < −100% loss.
  expect(d.totals.pnlAllTimeValue).toBeCloseTo(-7500, 2);
  expect(d.totals.pnlAllTime).toBeNull();
});

it('r80: mixed manual + connected → headline % is the MANUAL cost-basis % only; a connected realized gain never drags the base negative', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const manualId = await createManualPortfolio(userId, 'Manual');
  const connId = await createConnectedPortfolio(userId, 'Conn');
  // Manual: ETH avgCost 3000, balance 1, now 3200 → unrealized +200, realized 0 → all-time +200.
  await seedAssetWithCost(manualId, ethId, 1.0, { avgCost: 3000, costBasis: 3000, realizedPnl: 0 });
  // Connected: a BIG realized gain (+50000) on top of unrealized +43000 (BTC 1 @ 93000, cost 50000)
  // → all-time +93000. This is exactly the case where currentValue(93000) − allTime(93000) = 0 (and
  // any larger realized goes negative), which used to drag the aggregate base negative → absurd %.
  await seedAssetWithCost(connId, btcId, 1.0, { avgCost: 50000, costBasis: 50000, realizedPnl: 50000 });

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Headline % = the MANUAL cost-basis % only: 200 / 3000 × 100 = 6.67 (connected excluded). The old
  // code mixed connected in and produced ~3106% (93200 / (96200 − 93200)).
  expect(d.totals.pnlAllTime).toBeCloseTo(6.67, 2);
  // The headline VALUE still includes the connected all-time: manual 200 + connected 93000 = 93200.
  expect(d.totals.pnlAllTimeValue).toBeCloseTo(93200, 2);
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

it('r74-txcount: transactionCount = connected on-chain total (externalTxCount) + manual DB rows', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const manual = await createManualPortfolio(userId, 'M');
  const connected = await createConnectedPortfolio(userId, 'C');
  // The connected wallet reports 421 on-chain txns; only 3 were imported as rows.
  await prisma.portfolio.update({ where: { id: connected }, data: { externalTxCount: 421 } });
  await seedNativeTx(manual, '2026-01-01T00:00:00.000Z');
  await seedNativeTx(manual, '2026-01-02T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-03T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-04T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-05T00:00:00.000Z');

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // retrofit-74 (§1, reverts H10): the REAL total — 421 (connected on-chain) + 2 (manual DB
  // rows) = 423. The connected portfolio's own DB rows (3) are NOT added on top — externalTxCount
  // already IS its total. One honest number; no separate onChainTransactionCount.
  expect(d.totals.transactionCount).toBe(423);
  expect((d.totals as Record<string, unknown>).onChainTransactionCount).toBeUndefined();
});

it('r74-dedupe: the SAME wallet in two portfolios is not double-counted; distinct wallets are', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // Two connected portfolios sharing ONE wallet address, each carrying that wallet's 100-tx total.
  const sameWallet = `0x${'b'.repeat(40)}`;
  const c1 = await createConnectedPortfolio(userId, 'C1', sameWallet);
  const c2 = await createConnectedPortfolio(userId, 'C2', sameWallet);
  await prisma.portfolio.update({ where: { id: c1 }, data: { externalTxCount: 100 } });
  await prisma.portfolio.update({ where: { id: c2 }, data: { externalTxCount: 100 } });

  // Counted once for the shared wallet (100), not 200.
  const shared = await getData(await overviewGet(cookies));
  expect(shared.totals.transactionCount).toBe(100);

  // A THIRD connected portfolio on a DIFFERENT wallet adds its own total. Flush the per-user
  // overview cache first (60s TTL) so the second read reflects the new portfolio.
  const c3 = await createConnectedPortfolio(userId, 'C3', `0x${'c'.repeat(40)}`);
  await prisma.portfolio.update({ where: { id: c3 }, data: { externalTxCount: 30 } });
  const keys = await redis.keys('overview:*');
  if (keys.length > 0) await redis.del(keys);
  const both = await getData(await overviewGet(cookies));
  expect(both.totals.transactionCount).toBe(130); // 100 (shared, once) + 30 (distinct wallet)
});

it('r79-§5: a connected portfolio with NULL externalTxCount does NOT contribute its windowed DB count', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const manual = await createManualPortfolio(userId, 'M');
  // Connected portfolio synced before externalTxCount existed (null). It has 3 imported DB rows,
  // but those are a WINDOW — the windowed count would badly under-report, so it must NOT be used.
  const connected = await createConnectedPortfolio(userId, 'C');
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: connected } })).externalTxCount).toBeNull();
  await seedNativeTx(manual, '2026-01-01T00:00:00.000Z');
  await seedNativeTx(manual, '2026-01-02T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-03T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-04T00:00:00.000Z');
  await seedNativeTx(connected, '2026-01-05T00:00:00.000Z');

  const d = await getData(await overviewGet(cookies));
  // Only the manual DB rows (2) count; the connected portfolio's 3 windowed rows are excluded
  // (its real total is unknown until a resync populates externalTxCount).
  expect(d.totals.transactionCount).toBe(2);
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

// ---------------------------------------------------------------------------
// retrofit-66 — per-portfolio inceptionDate = min(createdAt, earliest tx timestamp)
// ---------------------------------------------------------------------------

it('r66: fresh manual portfolio inceptionDate == createdAt; a backdated tx moves it earlier', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const fresh = await createManualPortfolio(userId, 'Fresh');
  const backdated = await createManualPortfolio(userId, 'Backdated');
  // A logged transaction backdated to 2024 → inception starts at that tx, not createdAt.
  await seedNativeTx(backdated, '2024-03-15T00:00:00.000Z');

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const freshRow = d.portfolios.find((p) => p.name === 'Fresh')!;
  const backdatedRow = d.portfolios.find((p) => p.name === 'Backdated')!;

  // Fresh (no txns): inceptionDate == the portfolio's createdAt (today).
  const freshDb = await prisma.portfolio.findUniqueOrThrow({ where: { id: fresh } });
  expect(freshRow.inceptionDate).toBe(freshDb.createdAt.toISOString());
  // Backdated: the 2024 tx predates createdAt → inception is that tx's timestamp.
  expect(backdatedRow.inceptionDate).toBe('2024-03-15T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// retrofit-67 — leading-$0 snapshots are trimmed from the value-history series
// ---------------------------------------------------------------------------

it('r67: leading $0 points trimmed from valueHistory/connectedValueHistory; interior zeros kept', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const connected = await createConnectedPortfolio(userId, 'Connected');
  // Pre-funding leading zeros, then real value, an interior $0 day (drained), then value again.
  await seedSnapshot(connected, userId, '2026-06-06', 0);
  await seedSnapshot(connected, userId, '2026-06-07', 0);
  await seedSnapshot(connected, userId, '2026-06-08', 100);
  await seedSnapshot(connected, userId, '2026-06-09', 0); // interior zero — preserved
  await seedSnapshot(connected, userId, '2026-06-10', 120);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // The two leading $0 days are dropped; the interior 06-09 $0 stays; series starts at funding.
  expect(d.connectedValueHistory).toEqual([
    { date: '2026-06-08', value: 100, approx: false },
    { date: '2026-06-09', value: 0, approx: false },
    { date: '2026-06-10', value: 120, approx: false },
  ]);
  // Aggregate valueHistory (only this connected portfolio here) trims identically.
  expect(d.valueHistory).toEqual([
    { date: '2026-06-08', value: 100, approx: false },
    { date: '2026-06-09', value: 0, approx: false },
    { date: '2026-06-10', value: 120, approx: false },
  ]);
});

// ---------------------------------------------------------------------------
// 386 — topMovers: ranked by |change24h| desc, capped at 6 (retrofit-18)
// ---------------------------------------------------------------------------

it('386: topMovers = catalog tokens with a live tick, sorted by |change24h| desc, capped at 6', async () => {
  const cookies = await registerAndLogin();
  // 7 fresh ticks with distinct |change24h| (mix of +/- to prove BOTH directions count),
  // plus a tick missing change24h (must be skipped, not crash).
  await seedPriceTick('BTC', 10); // |10|
  await seedPriceTick('ETH', -8); // |8|
  await seedPriceTick('SOL', 6); // |6|
  await seedPriceTick('ADA', -4); // |4|
  await seedPriceTick('DOT', 2); // |2|
  await seedPriceTick('LINK', -1); // |1|
  await seedPriceTick('AVAX', 0.5); // |0.5| — falls outside the top 6
  await seedPriceTick('USDT', null); // no change24h → skipped

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Capped at 6, ordered by absolute change desc (largest mover first, either direction).
  expect(d.topMovers).toHaveLength(6);
  expect(d.topMovers.map((m) => m.symbol)).toEqual(['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK']);
  // Shape: { symbol, name, change24h, spark } with catalog name + signed change
  // preserved; spark is [] here (no price_hist:<SYMBOL> list seeded — retrofit-20).
  expect(d.topMovers[0]).toEqual({ symbol: 'BTC', name: 'Bitcoin', change24h: 10, spark: [] });
  expect(d.topMovers[1]).toEqual({ symbol: 'ETH', name: 'Ethereum', change24h: -8, spark: [] });
  expect(d.topMovers[5]).toEqual({ symbol: 'LINK', name: 'Chainlink', change24h: -1, spark: [] });
  // The 7th-largest mover and the change24h-less tick are excluded.
  expect(d.topMovers.map((m) => m.symbol)).not.toContain('AVAX');
  expect(d.topMovers.map((m) => m.symbol)).not.toContain('USDT');
  // Sorted strictly by |change24h| desc.
  const abs = d.topMovers.map((m) => Math.abs(m.change24h));
  expect(abs).toEqual([...abs].sort((a, b) => b - a));

  // 60s global cache key is populated with the computed list.
  const cached = await redis.get('overview_top_movers');
  expect(cached).not.toBeNull();
  expect((JSON.parse(cached!) as unknown[]).length).toBe(6);
});

// ---------------------------------------------------------------------------
// 387 — topMovers: no live ticks → [] (frontend empty state, never an error)
// ---------------------------------------------------------------------------

it('387: topMovers is [] when no symbol has a fresh tick (feeds down)', async () => {
  const cookies = await registerAndLogin();
  // beforeEach flushed price:* and overview_top_movers — no ticks seeded here.
  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);
  expect(d.topMovers).toEqual([]);
  // The empty list is still cached (so we don't recompute every request for 60s).
  expect(await redis.get('overview_top_movers')).toBe('[]');
});

// ---------------------------------------------------------------------------
// 390 — real 24h PnL from the latest BalanceSnapshot ≤24h old (retrofit-20, Part 1)
// ---------------------------------------------------------------------------

it('390: totals.pnl24h* = current total − latest snapshot ≤24h old (matching %)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p = await createManualPortfolio(userId, 'P', 50000);
  await seedAsset(p, btcId, 1.0);
  // Live tick → current BTC price 100000 (overlays the seeded currentPrice), so the
  // current total (100000) differs from the snapshot baseline below.
  await seedPriceTick('BTC', 5, 100000);
  // Daily snapshot dated ~25h ago (the "last daily close") with a known value 80000.
  const ymd25hAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await seedSnapshot(p, userId, ymd25hAgo, 80000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  expect(d.totals.totalValue).toBeCloseTo(100000, 2);
  // pnl24hValue = current total (100000) − snapshot baseline (80000) = 20000
  expect(d.totals.pnl24hValue).toBe(20000);
  // pnl24h = 20000 / 80000 * 100 = 25.00 (the matching %)
  expect(d.totals.pnl24h).toBe(25);

  // retrofit-70 (C2): allocation is valued off the SAME live price as the headline, so the
  // donut slices sum to the total. Pre-retrofit-70 the BTC slice used the stale daily
  // currentPrice (93000) while the total was live (100000) — they no longer diverge.
  const allocBtc = d.allocation.find((a) => a.symbol === 'BTC')!;
  expect(allocBtc.value).toBeCloseTo(100000, 2); // live price, not stale 93000
  expect(d.allocation.reduce((s, a) => s + a.value, 0)).toBeCloseTo(d.totals.totalValue, 2);
});

// ---------------------------------------------------------------------------
// 391 — real top-mover sparklines from sampled price_hist (retrofit-20, Part 2)
// ---------------------------------------------------------------------------

it('391: topMovers attach the sampled price_hist series as spark (oldest→newest); no list → []', async () => {
  const cookies = await registerAndLogin();
  // BTC: a live tick (so it ranks) + a sampled history list. The resolver LPUSHes the
  // newest sample at the head, so the stored order is newest→oldest; serve reverses it
  // to oldest→newest for the chart.
  await seedPriceTick('BTC', 10, 100000);
  await redis.rpush('price_hist:BTC', '105', '103', '101'); // newest→oldest, as stored
  // ETH: a live tick but NO history list → its spark must be [].
  await seedPriceTick('ETH', -8, 3000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const btc = d.topMovers.find((m) => m.symbol === 'BTC')!;
  const eth = d.topMovers.find((m) => m.symbol === 'ETH')!;
  expect(btc.spark).toEqual([101, 103, 105]); // oldest→newest (reversed from stored)
  expect(eth.spark).toEqual([]); // no history list → flat/empty
});

// ---------------------------------------------------------------------------
// r43a — sparkline reader tolerates the new "<ts>|<price>" history format
// (retrofit-43), still parses any legacy bare-price entries, and drops malformed ones.
// ---------------------------------------------------------------------------

it('r43a: topMovers spark parses "<ts>|<price>" entries, keeps legacy bare prices, drops malformed', async () => {
  const cookies = await registerAndLogin();
  await seedPriceTick('BTC', 10, 100000);
  // Stored newest→oldest (resolver LPUSHes newest at head). Mix the new timestamped
  // format with one legacy bare-price entry and one malformed entry.
  await redis.rpush(
    'price_hist:BTC',
    '1700000300000|105', // new format, newest
    'garbage', // malformed → dropped
    '1700000100000|101', // new format
    '99', // legacy bare price (pre-43) → still parsed
  );

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const btc = d.topMovers.find((m) => m.symbol === 'BTC')!;
  // Prices only, oldest→newest (reversed), malformed dropped: [99, 101, 105].
  expect(btc.spark).toEqual([99, 101, 105]);
});

// ---------------------------------------------------------------------------
// 392 — raw position holdings: per-portfolio + aggregate cost fields (retrofit-28)
// ---------------------------------------------------------------------------

it('392: each portfolio row carries holdings[] (excl. balance<=0); aggregate holdings sum cost + weight avgCost', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');

  // P1: BTC 1.0 (avgCost 90000, costBasis 90000, realized +500) + ETH 0.0 (excluded)
  await seedAssetWithCost(p1, btcId, 1.0, { avgCost: 90000, costBasis: 90000, realizedPnl: 500 });
  await seedAsset(p1, ethId, 0); // balance 0 → must NOT appear in holdings
  // P2: BTC 2.0 (avgCost 96000, costBasis 192000, realized -100) + USDT 1000 (cost-unknown)
  await seedAssetWithCost(p2, btcId, 2.0, { avgCost: 96000, costBasis: 192000, realizedPnl: -100 });
  await seedAssetWithCost(p2, usdtId, 1000, { avgCost: null, costBasis: 0, realizedPnl: 0 });

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // ---- per-portfolio holdings ----
  const r1 = d.portfolios.find((p) => p.name === 'P1')!;
  const r2 = d.portfolios.find((p) => p.name === 'P2')!;

  // P1: only BTC (ETH at balance 0 is excluded)
  expect(r1.holdings.map((h) => h.symbol)).toEqual(['BTC']);
  const r1Btc = r1.holdings[0]!;
  expect(r1Btc.balance).toBeCloseTo(1.0, 8);
  expect(r1Btc.avgCost).toBeCloseTo(90000, 2);
  expect(r1Btc.costBasis).toBeCloseTo(90000, 2);
  expect(r1Btc.realizedPnl).toBeCloseTo(500, 2);

  // P2: BTC + USDT; USDT is cost-unknown → avgCost null
  const r2Btc = r2.holdings.find((h) => h.symbol === 'BTC')!;
  const r2Usdt = r2.holdings.find((h) => h.symbol === 'USDT')!;
  expect(r2Btc.balance).toBeCloseTo(2.0, 8);
  expect(r2Btc.avgCost).toBeCloseTo(96000, 2);
  expect(r2Btc.costBasis).toBeCloseTo(192000, 2);
  expect(r2Btc.realizedPnl).toBeCloseTo(-100, 2);
  expect(r2Usdt.balance).toBeCloseTo(1000, 8);
  expect(r2Usdt.avgCost).toBeNull();
  expect(r2Usdt.costBasis).toBeCloseTo(0, 8);

  // ---- aggregate holdings (summed across portfolios) ----
  const aggBtc = d.holdings.find((h) => h.symbol === 'BTC')!;
  expect(aggBtc.balance).toBeCloseTo(3.0, 8); // 1.0 + 2.0
  expect(aggBtc.costBasis).toBeCloseTo(282000, 2); // 90000 + 192000
  expect(aggBtc.realizedPnl).toBeCloseTo(400, 2); // 500 + (-100)
  // balance-weighted avgCost = (90000*1 + 96000*2) / (1 + 2) = 94000
  expect(aggBtc.avgCost).toBeCloseTo(94000, 2);

  // USDT aggregate: cost-unknown only → avgCost null, costBasis 0
  const aggUsdt = d.holdings.find((h) => h.symbol === 'USDT')!;
  expect(aggUsdt.balance).toBeCloseTo(1000, 8);
  expect(aggUsdt.avgCost).toBeNull();
  expect(aggUsdt.costBasis).toBeCloseTo(0, 8);

  // ETH (balance 0) is absent everywhere.
  expect(d.holdings.map((h) => h.symbol)).not.toContain('ETH');
});

// ---------------------------------------------------------------------------
// retrofit-46 — GET /overview/transactions (cross-portfolio user tx list)
// ---------------------------------------------------------------------------

interface TxListResponse {
  data: { transactions: Array<{ id: number; portfolioId: number; timestamp: string }> };
}

it('r46-tx: GET /overview/transactions → all the user\'s txns across portfolios, newest-first', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  await seedNativeTx(p1, '2026-01-01T00:00:00.000Z');
  await seedNativeTx(p2, '2026-01-02T00:00:00.000Z');
  await seedNativeTx(p1, '2026-01-03T00:00:00.000Z');

  const res = await app.request(`${OVERVIEW_BASE}/transactions`, { headers: { Cookie: cookies } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as TxListResponse;
  // All three, newest-first (NOT limited by the /overview txLimit default of 10).
  expect(body.data.transactions.map((t) => t.timestamp)).toEqual([
    '2026-01-03T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  ]);
  expect(body.data.transactions[0]!.portfolioId).toBe(p1);
});

it('r46-tx-limit: GET /overview/transactions?limit=2 caps the list; bad limit clamps (never 400)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p = await createManualPortfolio(userId, 'P');
  await seedNativeTx(p, '2026-02-01T00:00:00.000Z');
  await seedNativeTx(p, '2026-02-02T00:00:00.000Z');
  await seedNativeTx(p, '2026-02-03T00:00:00.000Z');

  const capped = await app.request(`${OVERVIEW_BASE}/transactions?limit=2`, {
    headers: { Cookie: cookies },
  });
  expect(capped.status).toBe(200);
  const cappedBody = (await capped.json()) as TxListResponse;
  expect(cappedBody.data.transactions).toHaveLength(2);
  expect(cappedBody.data.transactions[0]!.timestamp).toBe('2026-02-03T00:00:00.000Z');

  // Non-numeric limit → clamp-never-400 stance: defaults to 500, returns all 3.
  const garbage = await app.request(`${OVERVIEW_BASE}/transactions?limit=abc`, {
    headers: { Cookie: cookies },
  });
  expect(garbage.status).toBe(200);
  const garbageBody = (await garbage.json()) as TxListResponse;
  expect(garbageBody.data.transactions).toHaveLength(3);
});

it('r46-tx-auth: GET /overview/transactions no session → 401', async () => {
  const res = await app.request(`${OVERVIEW_BASE}/transactions`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// retrofit-50 — ?portfolioIds= scopes the aggregate to the selected portfolios
// ---------------------------------------------------------------------------

it('r50-filter: ?portfolioIds= scopes totals/holdings/recentTransactions/count; foreign ids ignored; absent = all', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  // P1: BTC 1.0 (value 93000) + two txns. P2: ETH 1.0 (value 3200) + one txn.
  await seedAsset(p1, btcId, 1.0);
  await seedAsset(p2, ethId, 1.0);
  await seedNativeTx(p1, '2026-01-01T00:00:00.000Z');
  await seedNativeTx(p1, '2026-01-03T00:00:00.000Z');
  await seedNativeTx(p2, '2026-01-02T00:00:00.000Z');

  // --- filter to P1 only ---
  const justP1 = await getData(await overviewGet(cookies, `?portfolioIds=${p1}`));
  expect(justP1.totals.totalValue).toBeCloseTo(93000, 2);
  expect(justP1.totals.portfolioCount).toBe(1);
  expect(justP1.totals.transactionCount).toBe(2); // only P1's txns
  expect(justP1.portfolios.map((p) => p.name)).toEqual(['P1']);
  expect(justP1.allocation.map((a) => a.symbol)).toEqual(['BTC']);
  expect(justP1.holdings.map((h) => h.symbol)).toEqual(['BTC']);
  expect(justP1.recentTransactions.every((t) => t.portfolioId === p1)).toBe(true);
  expect(justP1.recentTransactions).toHaveLength(2);

  // --- a foreign / non-owned id in the list is silently dropped (no leak, no 400) ---
  const withForeign = await getData(await overviewGet(cookies, `?portfolioIds=${p1},999999`));
  expect(withForeign.totals.portfolioCount).toBe(1);
  expect(withForeign.totals.totalValue).toBeCloseTo(93000, 2);

  // --- both ids → both portfolios ---
  const both = await getData(await overviewGet(cookies, `?portfolioIds=${p1},${p2}`));
  expect(both.totals.portfolioCount).toBe(2);
  expect(both.totals.totalValue).toBeCloseTo(96200, 2);
  expect(both.totals.transactionCount).toBe(3);

  // --- absent filter → all portfolios (unchanged behaviour) ---
  const all = await getData(await overviewGet(cookies));
  expect(all.totals.portfolioCount).toBe(2);
  expect(all.totals.totalValue).toBeCloseTo(96200, 2);
});

// ---------------------------------------------------------------------------
// retrofit-75 (M16) — 24h totals exclude a portfolio with no ~24h-old snapshot
// (no phantom gain); totals.pnl24hValue == Σ per-portfolio pnl24hValue.
// ---------------------------------------------------------------------------

it('r75-24h: a portfolio with no 24h snapshot does NOT spike totals 24h; totals == Σ per-portfolio', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // C1 connected: BTC 1.0 (current 93000) WITH a ~24h-old snapshot (80000) → its own 24h
  // delta is +13000. M2 manual: USDT 4 (current 4) with NO snapshot → no 24h baseline.
  const c1 = await createConnectedPortfolio(userId, 'C1');
  const m2 = await createManualPortfolio(userId, 'M2');
  await seedAsset(c1, btcId, 1.0);
  await seedAsset(m2, usdtId, 4);
  const ymd2dAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await seedSnapshot(c1, userId, ymd2dAgo, 80000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Totals 24h = ONLY C1's delta (93000 − 80000). The pre-fix code summed M2's whole current
  // value as a phantom gain (would have been 13004); the fix restricts the delta to the
  // portfolios that actually have a 24h baseline.
  expect(d.totals.pnl24hValue).toBe(13000);
  expect(d.totals.pnl24hValue).not.toBe(13004);
  // pnl24h is over the included baseline only (80000), never diluted by M2's value.
  expect(d.totals.pnl24h).toBe(16.25); // 13000 / 80000 * 100

  // And the headline equals the sum of the per-portfolio 24h rows (C1 connected = 13000, M2
  // manual = null — retrofit-79 §2, no baseline → "—"). The null row is excluded from the sum.
  const sumRows = d.portfolios.reduce((s, p) => s + (p.pnl24hValue ?? 0), 0);
  expect(d.totals.pnl24hValue).toBe(sumRows);
  expect(d.portfolios.find((p) => p.name === 'C1')!.pnl24hValue).toBe(13000);
  expect(d.portfolios.find((p) => p.name === 'M2')!.pnl24hValue).toBeNull();
});

// ---------------------------------------------------------------------------
// retrofit-75 (R39) — manual all-time is canonical cost-basis: a stablecoin-only
// (cost-unknown) portfolio reads ~0%, a cost-tracked one reads its cost-basis PnL.
// ---------------------------------------------------------------------------

it('r75-alltime: USDT-only cost-unknown manual → ~0 all-time (not +33%); cost-tracked → cost-basis PnL; totals sum canonical', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // "Stable": 4 USDT, cost-UNKNOWN (avgCost null), netDeposit 3 — the exact R39 case. The old
  // netDeposit model read value(4) − netDeposit(3) = +$1 / +33%. The canonical cost-basis
  // all-time EXCLUDES the cost-unknown holding → 0.
  const stable = await createManualPortfolio(userId, 'Stable', 3);
  await seedAssetWithCost(stable, usdtId, 4, { avgCost: null, costBasis: 0, realizedPnl: 0 });
  // "Tracked": BTC 1.0 at avgCost 90000 (current 93000) → unrealized 3000, the canonical all-time.
  const tracked = await createManualPortfolio(userId, 'Tracked', 0);
  await seedAssetWithCost(tracked, btcId, 1.0, { avgCost: 90000, costBasis: 90000, realizedPnl: 0 });

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const stableRow = d.portfolios.find((p) => p.name === 'Stable')!;
  const trackedRow = d.portfolios.find((p) => p.name === 'Tracked')!;

  // Stablecoin-only: ~0 all-time, NOT the +$1/+33% netDeposit phantom.
  expect(stableRow.totalValue).toBeCloseTo(4, 2);
  expect(stableRow.pnlAllTimeValue).toBe(0);
  expect(stableRow.pnlAllTime).toBe(0);

  // Cost-tracked: canonical = cost-basis unrealized (93000 − 90000 = 3000), % over costBasis.
  expect(trackedRow.totalValue).toBeCloseTo(93000, 2);
  expect(trackedRow.pnlAllTimeValue).toBe(3000);
  expect(trackedRow.pnlAllTime).toBe(3.33); // 3000 / 90000 * 100 → 3.3333 → 2dp

  // Totals sum the canonical per-portfolio all-time (3000 + 0), % over the implied base.
  expect(d.totals.pnlAllTimeValue).toBe(3000);
  expect(d.totals.pnlAllTime).toBe(3.33); // 3000 / (93004 − 3000) * 100 = 3.3332… → 2dp
});

// ---------------------------------------------------------------------------
// retrofit-76 — a MANUAL portfolio now shows its OWN 24h delta on its row (was
// hardcoded 0 pre-76), and totals.pnl24hValue == Σ per-portfolio rows across a
// manual+connected mix (the headline can no longer disagree with the rows).
// ---------------------------------------------------------------------------

it('r76-manual-24h: manual portfolio with a 24h-ago snapshot shows its 24h delta on its row; totals == Σ rows (manual+connected)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // M manual: BTC 1.0 (current 93000) WITH a ~24h-old snapshot (80000) → own 24h delta +13000.
  // C connected: ETH 1.0 (current 3200) WITH a ~24h-old snapshot (3000) → own 24h delta +200.
  const m = await createManualPortfolio(userId, 'M', 50000);
  const c = await createConnectedPortfolio(userId, 'C');
  await seedAsset(m, btcId, 1.0);
  await seedAsset(c, ethId, 1.0);
  const ymd2dAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await seedSnapshot(m, userId, ymd2dAgo, 80000);
  await seedSnapshot(c, userId, ymd2dAgo, 3000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const mRow = d.portfolios.find((p) => p.name === 'M')!;
  const cRow = d.portfolios.find((p) => p.name === 'C')!;

  // retrofit-76: the MANUAL row carries its own 24h delta now (was the hardcoded 0 pre-76).
  expect(mRow.type).toBe('manual');
  expect(mRow.totalValue).toBeCloseTo(93000, 2);
  expect(mRow.pnl24hValue).toBe(13000); // 93000 − 80000
  expect(mRow.pnl24h).toBe(16.25); // 13000 / 80000 * 100

  // Connected row keeps its snapshot-delta 24h (the pre-existing path, unchanged).
  expect(cRow.pnl24hValue).toBe(200); // 3200 − 3000

  // The headline 24h equals the sum of the per-portfolio 24h rows (manual + connected): no
  // portfolio's change is in the totals but missing from its row, and none is invented.
  const sumRows = d.portfolios.reduce((s, p) => s + p.pnl24hValue, 0);
  expect(d.totals.pnl24hValue).toBe(13200); // 13000 + 200
  expect(d.totals.pnl24hValue).toBe(sumRows);
});

// ---------------------------------------------------------------------------
// retrofit-77 (N1) — a freshly-synced connected portfolio whose only ≤24h-old snapshot is
// a backfilled APPROXIMATE estimate must show 24h = 0 ("—"), NOT a garbage delta off the
// inflated estimate. A sibling with a REAL 24h-ago snapshot still shows its true delta, and
// the headline (which excludes the 0 portfolio from both sides, retrofit-75 M16) stays equal
// to Σ of the per-portfolio rows.
// ---------------------------------------------------------------------------

it('r77-approx: connected portfolio whose only 24h-ago snapshot is approx shows 24h=— (null); a sibling with a real snapshot shows the delta; totals == Σ rows', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  // Cfresh: freshly synced — its only ~24h-old snapshot is a backfilled ESTIMATE (approx=true).
  // Creal:  older portfolio — it has a REAL ~24h-old snapshot (approx=false), as Portfolio 2 does.
  const cFresh = await createConnectedPortfolio(userId, 'Cfresh', `0x${'a'.repeat(40)}`);
  const cReal = await createConnectedPortfolio(userId, 'Creal', `0x${'b'.repeat(40)}`);
  await seedAsset(cFresh, ethId, 1.0); // current 3200
  await seedAsset(cReal, ethId, 1.0); // current 3200
  const ymd2dAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  // Same nominal baseline (3000) for both — only the provenance flag differs, so any difference in
  // the reported 24h is solely the approx exclusion.
  await seedSnapshot(cFresh, userId, ymd2dAgo, 3000, { approx: true });
  await seedSnapshot(cReal, userId, ymd2dAgo, 3000); // real

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const freshRow = d.portfolios.find((p) => p.name === 'Cfresh')!;
  const realRow = d.portfolios.find((p) => p.name === 'Creal')!;

  // retrofit-79 (§2/D1): the approx-only portfolio reports NO 24h delta → null ("—"), not 0
  // (which would imply a real flat day) and not 3200 − 3000 = +200 off the inflated estimate.
  expect(freshRow.pnl24hValue).toBeNull();
  expect(freshRow.pnl24h).toBeNull();
  // The sibling with a real snapshot shows the true +200 delta off the identical baseline.
  expect(realRow.pnl24hValue).toBe(200); // 3200 − 3000

  // Headline still reconciles with the rows (the null portfolio is excluded from both sides).
  const sumRows = d.portfolios.reduce((s, p) => s + (p.pnl24hValue ?? 0), 0);
  expect(d.totals.pnl24hValue).toBe(200);
  expect(d.totals.pnl24hValue).toBe(sumRows);
});
