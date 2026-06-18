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
    // retrofit-28: raw per-portfolio position data for client recompute.
    holdings: Array<{
      symbol: string;
      balance: number;
      avgCost: number | null;
      costBasis: number;
      realizedPnl: number;
    }>;
  }>;
  valueHistory: Array<{ date: string; value: number }>;
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
  // retrofit-45: per-transaction chart markers, newest-first.
  markers: Array<{
    timestamp: string;
    direction: string;
    symbol: string;
    usdValue: number;
    valueAfter: number;
  }>;
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

// retrofit-45 reconstruction helpers --------------------------------------------------

// 'YYYY-MM-DD' for `n` whole days before now (UTC). The reconstruction axis is anchored
// to the real clock (last `days` UTC days ending today), so reconstruction tests MUST
// derive their dates from now — NOT hardcode them (mirrors test 390's ymd25hAgo).
function ymdDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// An asset whose OPENING lot (the reconstruction's starting balance) is set explicitly.
// `balance` (the live field, irrelevant to the reconstruction) defaults to openingBalance.
async function seedAssetWithOpening(
  portfolioId: number,
  tokenId: number,
  openingBalance: number,
  balance?: number,
): Promise<void> {
  await prisma.asset.create({
    data: {
      portfolioId,
      tokenId,
      balance: (balance ?? openingBalance).toString(),
      openingBalance: openingBalance.toString(),
    },
  });
}

// A daily global price row (the reconstruction's per-day price source; carries forward).
async function seedTokenPriceSnapshot(tokenId: number, ymd: string, price: number): Promise<void> {
  await prisma.tokenPriceSnapshot.create({
    data: { tokenId, snapshotDate: new Date(`${ymd}T00:00:00.000Z`), price: price.toString() },
  });
}

// A native buy/sell with an explicit amount/usdValue/timestamp (and optional transfer
// group). Drives the reconstruction's event stream. Timestamp is fixed at noon UTC of
// `ymd` so its UTC calendar date is unambiguous.
async function seedTokenTx(
  portfolioId: number,
  opts: {
    ymd: string;
    direction: 'buy' | 'sell';
    amount: number;
    usdValue: number;
    symbol?: string;
    transferGroupId?: string;
  },
): Promise<void> {
  const [typeRow, dirRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: opts.direction } }),
  ]);
  await prisma.transaction.create({
    data: {
      portfolioId,
      typeId: typeRow.id,
      directionId: dirRow.id,
      timestamp: new Date(`${opts.ymd}T12:00:00.000Z`),
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
      nativeDetail: {
        create: {
          amount: opts.amount.toString(),
          symbol: opts.symbol ?? 'BTC',
          usdValue: opts.usdValue.toString(),
        },
      },
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
  // retrofit-45: token_price_snapshot is a GLOBAL catalog table (not user data, so
  // truncateAllUserData leaves it). The reconstruction reads it — clear so a row seeded
  // by a prior test (or another file) can't bleed a price into the value series.
  await prisma.tokenPriceSnapshot.deleteMany({});
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
  await prisma.tokenPriceSnapshot.deleteMany({});
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
  expect(d.markers).toEqual([]); // retrofit-45
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
  expect(r1.pnlAllTimeValue).toBeCloseTo(19400, 2); // 99400 - 80000
  expect(r2.totalValue).toBeCloseTo(47500, 2);
  expect(r2.pnlAllTimeValue).toBeCloseTo(7500, 2); // 47500 - 40000
});

// ---------------------------------------------------------------------------
// 373 — reconstructed value history steps on buy/sell (retrofit-45, replaces the
//       old BalanceSnapshot forward-fill). Opening lot + a buy + a sell, valued at
//       that day's TokenPriceSnapshot, must STEP up on the buy day and down on the sell.
// ---------------------------------------------------------------------------

it('373: valueHistory reconstructs actual holdings — steps up on the buy, down on the sell', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  // Opening BTC lot of 1.0; a +1.0 buy 4 days ago; a -0.5 sell 2 days ago.
  await seedAssetWithOpening(p1, btcId, 1.0);
  await seedTokenTx(p1, { ymd: ymdDaysAgo(4), direction: 'buy', amount: 1.0, usdValue: 100 });
  await seedTokenTx(p1, { ymd: ymdDaysAgo(2), direction: 'sell', amount: 0.5, usdValue: 55 });
  // One price snapshot 6 days ago = 100 carries forward across the whole window.
  await seedTokenPriceSnapshot(btcId, ymdDaysAgo(6), 100);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Reconstructed balance × 100 on each key day (carry-forward price):
  //   6d ago: 1.0 (opening, pre-buy)            → 100
  //   4d ago: 2.0 (after +1.0 buy)              → 200
  //   2d ago: 1.5 (after −0.5 sell)             → 150
  //   today : 1.5 (no later events)             → 150
  const at = (n: number) => d.valueHistory.find((p) => p.date === ymdDaysAgo(n));
  expect(at(6)).toEqual({ date: ymdDaysAgo(6), value: 100 });
  expect(at(4)).toEqual({ date: ymdDaysAgo(4), value: 200 });
  expect(at(2)).toEqual({ date: ymdDaysAgo(2), value: 150 });
  expect(at(0)).toEqual({ date: ymdDaysAgo(0), value: 150 });
});

// ---------------------------------------------------------------------------
// 374 — ?days=N clamps the axis to the last N days, AND pre-window events still
//       seed the starting balance (the reconstruction never "forgets" earlier txs).
// ---------------------------------------------------------------------------

it('374: ?days=3 returns exactly 3 days; events before the window still count toward balance', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  await seedAssetWithOpening(p1, btcId, 1.0);
  // The 4d-ago buy is fully OUTSIDE the 3-day window (window = last 3 days: 2d,1d,today);
  // the 2d-ago sell lands on the window edge. Both must still seed the balance.
  await seedTokenTx(p1, { ymd: ymdDaysAgo(4), direction: 'buy', amount: 1.0, usdValue: 100 });
  await seedTokenTx(p1, { ymd: ymdDaysAgo(2), direction: 'sell', amount: 0.5, usdValue: 55 });
  // Price snapshot must be WITHIN the fetched window (the bulk fetch is snapshotDate >=
  // rangeStart, per spec), so seed it at the window start; it carries forward across all 3.
  await seedTokenPriceSnapshot(btcId, ymdDaysAgo(2), 100);

  const res = await overviewGet(cookies, '?days=3');
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Window = [2d, 1d, today]. By the first day (2d ago) BOTH events have applied →
  // balance 1.0 + 1.0 − 0.5 = 1.5 → 150, flat across the 3 days.
  expect(d.valueHistory).toEqual([
    { date: ymdDaysAgo(2), value: 150 },
    { date: ymdDaysAgo(1), value: 150 },
    { date: ymdDaysAgo(0), value: 150 },
  ]);
});

// ---------------------------------------------------------------------------
// r45a — markers: one entry per buy/sell, newest-first, with valueAfter = the
//        reconstructed total right AFTER the tx at that day's price.
// ---------------------------------------------------------------------------

it('r45a: markers carry direction/symbol/usdValue + reconstructed valueAfter, newest-first', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  await seedAssetWithOpening(p1, btcId, 1.0);
  await seedTokenTx(p1, { ymd: ymdDaysAgo(4), direction: 'buy', amount: 1.0, usdValue: 100 });
  await seedTokenTx(p1, { ymd: ymdDaysAgo(2), direction: 'sell', amount: 0.5, usdValue: 55 });
  await seedTokenPriceSnapshot(btcId, ymdDaysAgo(6), 100);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Newest-first: the 2d-ago sell, then the 4d-ago buy.
  expect(d.markers).toHaveLength(2);
  expect(d.markers[0]).toEqual({
    timestamp: `${ymdDaysAgo(2)}T12:00:00.000Z`,
    direction: 'sell',
    symbol: 'BTC',
    usdValue: 55,
    valueAfter: 150, // balance 1.5 × 100
  });
  expect(d.markers[1]).toEqual({
    timestamp: `${ymdDaysAgo(4)}T12:00:00.000Z`,
    direction: 'buy',
    symbol: 'BTC',
    usdValue: 100,
    valueAfter: 200, // balance 2.0 × 100
  });
});

// ---------------------------------------------------------------------------
// r45b — a token with NO price snapshot on a day falls back to Token.currentPrice.
// ---------------------------------------------------------------------------

it('r45b: a held token with no snapshots values at Token.currentPrice (fallback)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  // Opening 2.0 BTC, NO TokenPriceSnapshot rows → every day falls back to the seeded
  // catalog currentPrice (BTC 93000). No events → balance is flat 2.0 across the axis.
  await seedAssetWithOpening(p1, btcId, 2.0);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  // Today's point uses the currentPrice fallback: 2.0 × 93000 = 186000.
  expect(d.valueHistory.at(-1)).toEqual({ date: ymdDaysAgo(0), value: 186000 });
  // Flat (no events, single carry-forward price) across the whole series.
  expect(d.valueHistory.every((p) => p.value === 186000)).toBe(true);
});

// ---------------------------------------------------------------------------
// r45c — transfer-group legs MOVE balance (so they net to zero in the aggregate
//        series across portfolios) but are EXCLUDED from markers.
// ---------------------------------------------------------------------------

it('r45c: transfer legs net-zero in the series and are excluded from markers', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  // Aggregate opening BTC = 2.0 (all in P1; P2 holds the token at 0 so it's in scope).
  await seedAssetWithOpening(p1, btcId, 2.0);
  await seedAssetWithOpening(p2, btcId, 0.0);
  // A real (non-transfer) +0.5 buy 4 days ago → appears in markers.
  await seedTokenTx(p1, { ymd: ymdDaysAgo(4), direction: 'buy', amount: 0.5, usdValue: 50 });
  // A cross-portfolio transfer 2 days ago: −1.0 from P1, +1.0 into P2 (same group).
  await seedTokenTx(p1, { ymd: ymdDaysAgo(2), direction: 'sell', amount: 1.0, usdValue: 100, transferGroupId: 'grp-1' });
  await seedTokenTx(p2, { ymd: ymdDaysAgo(2), direction: 'buy', amount: 1.0, usdValue: 100, transferGroupId: 'grp-1' });
  await seedTokenPriceSnapshot(btcId, ymdDaysAgo(6), 100);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const d = await getData(res);

  const at = (n: number) => d.valueHistory.find((p) => p.date === ymdDaysAgo(n));
  // 6d: 2.0 → 200; 4d: 2.5 (after +0.5 buy) → 250; 2d: still 2.5 (transfer nets 0) → 250.
  expect(at(6)).toEqual({ date: ymdDaysAgo(6), value: 200 });
  expect(at(4)).toEqual({ date: ymdDaysAgo(4), value: 250 });
  expect(at(2)).toEqual({ date: ymdDaysAgo(2), value: 250 });

  // Only the non-transfer buy surfaces as a marker; both grp-1 legs are excluded.
  expect(d.markers).toHaveLength(1);
  expect(d.markers[0]).toEqual({
    timestamp: `${ymdDaysAgo(4)}T12:00:00.000Z`,
    direction: 'buy',
    symbol: 'BTC',
    usdValue: 50,
    valueAfter: 250, // aggregate balance 2.5 × 100
  });
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
