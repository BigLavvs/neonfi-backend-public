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

// retrofit-88 (Issue 1): the /portfolios summary DTO is the surface whose pnlAllTimeValue/pnlAllTime
// must agree with the overview's per-portfolio P&L — fetch it to assert all three measures align.
async function portfoliosGet(cookies: string): Promise<
  Array<{ id: number; name: string; pnlAllTimeValue: number; pnlAllTime: number; allTimePnlValue: number; netDeposit: number; totalValue: number }>
> {
  const res = await app.request('/api/v1/portfolios', {
    method: 'GET',
    headers: { Cookie: cookies },
  });
  const json = (await res.json()) as { data: { portfolios: Array<Record<string, number>> } };
  return json.data.portfolios as never;
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
