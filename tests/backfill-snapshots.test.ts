// Neonfi backend — snapshot-history backfill tests (retrofit-41/42).
//
// retrofit-42 sources REAL daily history from CoinGecko (mocked here — no live network) with a
// synthetic fallback, and adds a dev-friendly boot catch-up. We assert: the symbol→id map resolves
// a colliding ticker to the highest-market-cap coin; buildRealSeries collapses raw points to a
// DAYS-length series ending on the latest real price; a mapped token gets real history while an
// unmapped token falls back to a synthetic series; balance_snapshot value == Σ(balance × that-day
// price); re-runs are idempotent; and the boot catch-up writes today's snapshot when absent and
// skips when present.

import { it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAllUserData } from './helpers.js';
import {
  runSnapshotsBackfill,
  buildSymbolIdMap,
  buildRealSeries,
  seriesFor,
  DAYS,
  type CoinGeckoSource,
  type CoinGeckoMarket,
} from '../src/scripts/backfill-snapshots.js';
import { runSnapshotCatchUpIfNeeded } from '../src/jobs/snapshot.job.js';

let btcId: number;
let usdtId: number;

const todayMidnightUtcMs = (): number =>
  new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();

// A DAYS-length UTC date grid identical to the one the script builds (index 0 oldest, DAYS-1 today).
function ymdGrid(): string[] {
  const base = todayMidnightUtcMs();
  return Array.from({ length: DAYS }, (_, i) =>
    new Date(base - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

// One flat daily point per UTC day for the last 365 days, ending today on `latest`.
function dailyPoints(latest: number): Array<[number, number]> {
  const base = todayMidnightUtcMs();
  return Array.from({ length: DAYS }, (_, i) => {
    const day = DAYS - 1 - i;
    return [base - day * 86_400_000 + 12 * 3_600_000, latest] as [number, number];
  });
}

const BTC_LATEST = 12345.67;
const ETH_LATEST = 2222.22;

// Mock CoinGecko: BTC + ETH mapped (real history); everything else unmapped (synthetic fallback).
function mockSource(): CoinGeckoSource {
  const markets: CoinGeckoMarket[] = [
    { id: 'bitcoin', symbol: 'btc', marketCap: 1e12 },
    { id: 'ethereum', symbol: 'eth', marketCap: 5e11 },
  ];
  const charts: Record<string, Array<[number, number]>> = {
    bitcoin: dailyPoints(BTC_LATEST),
    ethereum: dailyPoints(ETH_LATEST),
  };
  return {
    fetchMarkets: async () => markets,
    fetchMarketChart: async (id) => charts[id] ?? [],
  };
}

beforeAll(async () => {
  const [btc, usdt] = await Promise.all([
    prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } }),
    prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } }),
  ]);
  btcId = btc.id;
  usdtId = usdt.id;
});

beforeEach(async () => {
  // token_price_snapshot is keyed off the seeded Token catalog (not user data), so
  // truncateAllUserData (CASCADE from portfolio) never reaches it — clear it explicitly.
  await prisma.tokenPriceSnapshot.deleteMany({});
  await truncateAllUserData();
});

afterAll(async () => {
  await prisma.tokenPriceSnapshot.deleteMany({});
  await prisma.balanceSnapshot.deleteMany({});
});

// --- pure helpers -----------------------------------------------------------

it('r42-map: buildSymbolIdMap resolves a colliding ticker to the highest-market-cap coin', () => {
  // Deliberately unsorted so the result depends on market cap, not input order.
  const markets: CoinGeckoMarket[] = [
    { id: 'junk-uni', symbol: 'uni', marketCap: 1_000 },
    { id: 'uniswap', symbol: 'uni', marketCap: 9_000_000_000 },
    { id: 'bitcoin', symbol: 'BTC', marketCap: 1e12 }, // upstream casing varies; map lowercases
  ];
  const map = buildSymbolIdMap(markets);
  expect(map.get('uni')).toBe('uniswap');
  expect(map.get('btc')).toBe('bitcoin');
});

it('r42-series: buildRealSeries → DAYS rows, ends on latest, forward/back-fills, last-point-per-day wins', () => {
  const ymd = ymdGrid();
  const base = todayMidnightUtcMs();
  const dayTs = (daysAgo: number, hour: number) => base - daysAgo * 86_400_000 + hour * 3_600_000;
  // Points only on the last 3 days; the most recent day has TWO points (later one must win).
  const prices: Array<[number, number]> = [
    [dayTs(2, 12), 10],
    [dayTs(1, 12), 20],
    [dayTs(0, 6), 999], // earlier point today — should be overwritten
    [dayTs(0, 18), 30], // latest point today — wins
  ];
  const series = buildRealSeries(prices, ymd)!;
  expect(series).toHaveLength(DAYS);
  expect(series[DAYS - 1]).toBe(30); // ends on the latest real price
  expect(series[DAYS - 2]).toBe(20);
  expect(series[DAYS - 3]).toBe(10);
  expect(series[0]).toBe(10); // leading dates back-fill from the oldest known
  expect(buildRealSeries([], ymd)).toBeNull(); // no usable points → caller falls back
});

// --- integration ------------------------------------------------------------

it('r42a: a mapped token gets REAL history (ends on latest), an unmapped token falls back to synthetic', async () => {
  const tokenCount = await prisma.token.count();
  const result = await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });

  expect(result.mapped).toBe(2); // BTC + ETH
  expect(result.realTokens).toBe(2);
  expect(result.syntheticFallback).toBe(tokenCount - 2);
  expect(result.tokenRows).toBe(tokenCount * DAYS);

  // BTC: real, flat at the mocked latest — every day equals BTC_LATEST (distinct from a synthetic walk).
  const btcRows = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId: btcId },
    orderBy: { snapshotDate: 'asc' },
  });
  expect(btcRows).toHaveLength(DAYS);
  expect(Number(btcRows[DAYS - 1]!.price.toString())).toBeCloseTo(BTC_LATEST, 2);
  expect(Number(btcRows[0]!.price.toString())).toBeCloseTo(BTC_LATEST, 2);
  expect(btcRows[DAYS - 1]!.snapshotDate.toISOString().slice(0, 10)).toBe(
    new Date().toISOString().slice(0, 10),
  );

  // USDT: unmapped → synthetic series ending exactly on its stored currentPrice.
  const usdt = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } });
  const usdtRows = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId: usdtId },
    orderBy: { snapshotDate: 'asc' },
  });
  expect(usdtRows).toHaveLength(DAYS);
  expect(Number(usdtRows[DAYS - 1]!.price.toString())).toBeCloseTo(Number(usdt.currentPrice.toString()), 8);
});

it('r42b: balance_snapshot gets DAYS rows; each value == Σ(balance × that-day token price)', async () => {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const user = await prisma.user.create({
    data: {
      email: 'backfill.snap.b@neonfi.test',
      passwordHash: 'x',
      fullName: 'Backfill Snapshots User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  const portfolio = await prisma.portfolio.create({ data: { userId: user.id, name: 'Main', typeId: type.id } });
  await prisma.asset.create({ data: { portfolioId: portfolio.id, tokenId: btcId, balance: '2' } });
  await prisma.asset.create({ data: { portfolioId: portfolio.id, tokenId: usdtId, balance: '100' } });

  const result = await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });
  expect(result.portfolioRows).toBe(DAYS);

  const balanceRows = await prisma.balanceSnapshot.findMany({
    where: { portfolioId: portfolio.id },
    orderBy: { snapshotDate: 'asc' },
  });
  expect(balanceRows).toHaveLength(DAYS);
  for (const r of balanceRows) expect(r.userId).toBe(user.id);

  // Recompute expected daily value from the SAME per-day prices the backfill wrote.
  const priceByDay = async (tokenId: number): Promise<Map<string, number>> => {
    const rows = await prisma.tokenPriceSnapshot.findMany({ where: { tokenId }, select: { snapshotDate: true, price: true } });
    return new Map(rows.map((r) => [r.snapshotDate.toISOString().slice(0, 10), Number(r.price.toString())]));
  };
  const btcByDay = await priceByDay(btcId);
  const usdtByDay = await priceByDay(usdtId);
  for (const r of balanceRows) {
    const ymd = r.snapshotDate.toISOString().slice(0, 10);
    const expected = 2 * btcByDay.get(ymd)! + 100 * usdtByDay.get(ymd)!;
    expect(Number(r.value.toString())).toBeCloseTo(expected, 2);
  }
});

it('r42c: re-running is idempotent — same row counts and same values', async () => {
  const first = await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });
  const firstBtc = await prisma.tokenPriceSnapshot.findMany({ where: { tokenId: btcId }, orderBy: { snapshotDate: 'asc' } });

  const second = await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });
  expect(second.realTokens).toBe(first.realTokens);
  expect(second.tokenRows).toBe(first.tokenRows);
  expect(await prisma.tokenPriceSnapshot.count({ where: { tokenId: btcId } })).toBe(DAYS);

  const secondBtc = await prisma.tokenPriceSnapshot.findMany({ where: { tokenId: btcId }, orderBy: { snapshotDate: 'asc' } });
  for (let i = 0; i < DAYS; i++) {
    expect(secondBtc[i]!.price.toString()).toBe(firstBtc[i]!.price.toString());
  }
});

it('r78-A1: backfill rows are approx=true and a re-run never clobbers a real (approx=false) daily snapshot', async () => {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const user = await prisma.user.create({
    data: {
      email: 'backfill.snap.a1@neonfi.test',
      passwordHash: 'x',
      fullName: 'Backfill A1 User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  const portfolio = await prisma.portfolio.create({ data: { userId: user.id, name: 'Main', typeId: type.id } });
  await prisma.asset.create({ data: { portfolioId: portfolio.id, tokenId: btcId, balance: '2' } });

  // A REAL daily-job snapshot already exists for TODAY (the backfill writes that date too) — a
  // distinctive value + approx=false, exactly what the cron would leave.
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const REAL_VALUE = 123456.789; // distinct from any Σ(balance × mocked price) the backfill computes
  await prisma.balanceSnapshot.create({
    data: { portfolioId: portfolio.id, userId: user.id, snapshotDate: today, value: REAL_VALUE.toString(), approx: false },
  });

  await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });

  // Today's real row is untouched: same value, still approx=false (the conflict clause only
  // overwrites already-approx rows).
  const todayRow = await prisma.balanceSnapshot.findUniqueOrThrow({
    where: { portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate: today } },
  });
  expect(Number(todayRow.value.toString())).toBeCloseTo(REAL_VALUE, 5);
  expect(todayRow.approx).toBe(false);

  // Every OTHER (historical) row the script wrote is an estimate → approx=true, so it can never
  // serve as a short-term baseline (retrofit-77).
  const historical = await prisma.balanceSnapshot.findMany({
    where: { portfolioId: portfolio.id, snapshotDate: { lt: today } },
    select: { approx: true },
  });
  expect(historical.length).toBe(DAYS - 1);
  expect(historical.every((r) => r.approx === true)).toBe(true);
});

it('r42-fallback: an unmapped token uses the deterministic synthetic series (seriesFor)', async () => {
  await runSnapshotsBackfill({ source: mockSource(), throttleMs: 0 });
  const usdt = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } });
  const expected = seriesFor(Number(usdt.currentPrice.toString()), usdtId);
  const rows = await prisma.tokenPriceSnapshot.findMany({ where: { tokenId: usdtId }, orderBy: { snapshotDate: 'asc' } });
  expect(rows).toHaveLength(DAYS);
  // Spot-check the oldest synthetic day matches seriesFor exactly (formatted to 8dp).
  expect(Number(rows[0]!.price.toString())).toBeCloseTo(expected[0]!, 6);
});

// --- Part B1: boot catch-up -------------------------------------------------

it('r42-B1: catch-up writes today’s snapshot when absent, then skips (no duplicate) when present', async () => {
  const tokenCount = await prisma.token.count();
  const today = new Date().toISOString().slice(0, 10);

  // beforeEach already cleared token_price_snapshot → today is absent.
  const ranFirst = await runSnapshotCatchUpIfNeeded();
  expect(ranFirst).toBe(true);
  const afterFirst = await prisma.tokenPriceSnapshot.count({
    where: { snapshotDate: new Date(`${today}T00:00:00.000Z`) },
  });
  expect(afterFirst).toBe(tokenCount); // job wrote one row per catalog token for today

  // Today is now present → catch-up is a no-op, no duplicate rows.
  const ranSecond = await runSnapshotCatchUpIfNeeded();
  expect(ranSecond).toBe(false);
  const afterSecond = await prisma.tokenPriceSnapshot.count({
    where: { snapshotDate: new Date(`${today}T00:00:00.000Z`) },
  });
  expect(afterSecond).toBe(tokenCount);
});
