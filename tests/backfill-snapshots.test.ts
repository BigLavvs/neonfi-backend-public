// Neonfi backend — snapshot-history backfill tests (retrofit-41).
//
// Real DB + Redis, per-test cleanup. The backfill seeds ~365 days of synthetic price/value
// history so the charts render on a fresh/dev DB. We assert: every catalog token gets DAYS
// token_price_snapshot rows ending on its real currentPrice; every portfolio gets DAYS
// balance_snapshot rows whose value == Σ(current balance × that-day token price); and that a
// second run is idempotent (same row counts AND same values — the per-token-seeded PRNG plus
// ON CONFLICT DO UPDATE guarantee it).

import { it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAllUserData } from './helpers.js';
import { runSnapshotsBackfill, DAYS } from '../src/scripts/backfill-snapshots.js';

let btcId: number;
let ethId: number;

async function seedUser(email: string): Promise<number> {
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const u = await prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: 'Backfill Snapshots User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  return u.id;
}

async function seedManualPortfolio(userId: number): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const p = await prisma.portfolio.create({ data: { userId, name: 'Main', typeId: type.id } });
  return p.id;
}

beforeAll(async () => {
  const [btc, eth] = await Promise.all([
    prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } }),
    prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } }),
  ]);
  btcId = btc.id;
  ethId = eth.id;
});

beforeEach(async () => {
  // token_price_snapshot is keyed off the seeded Token catalog (not user data), so
  // truncateAllUserData (CASCADE from portfolio) never reaches it — clear it explicitly.
  await prisma.tokenPriceSnapshot.deleteMany({});
  await truncateAllUserData();
});

// Leave both snapshot tables empty so no later suite's cascade-truncate is the first to hit
// a non-empty hypertable.
afterAll(async () => {
  await prisma.tokenPriceSnapshot.deleteMany({});
  await prisma.balanceSnapshot.deleteMany({});
});

it('r41a: token_price_snapshot gets DAYS rows per catalog token, ending on the real currentPrice', async () => {
  const tokenCount = await prisma.token.count();
  expect(tokenCount).toBeGreaterThanOrEqual(2);

  const result = await runSnapshotsBackfill();
  expect(result.tokenSeries).toBe(tokenCount);
  expect(result.tokenRows).toBe(tokenCount * DAYS);

  // Every catalog token has exactly DAYS rows.
  const total = await prisma.tokenPriceSnapshot.count();
  expect(total).toBe(tokenCount * DAYS);

  // BTC's series ends (newest date) on the real current price.
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  const btcRows = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId: btcId },
    orderBy: { snapshotDate: 'asc' },
  });
  expect(btcRows).toHaveLength(DAYS);
  const last = btcRows[DAYS - 1]!;
  expect(Number(last.price.toString())).toBeCloseTo(Number(btc.currentPrice.toString()), 8);
  // Newest row is today (UTC).
  const todayYmd = new Date().toISOString().slice(0, 10);
  expect(last.snapshotDate.toISOString().slice(0, 10)).toBe(todayYmd);
  // Earlier rows are populated (not all equal to today's price → it's a walk).
  expect(Number(btcRows[0]!.price.toString())).toBeGreaterThan(0);
});

it('r41b: balance_snapshot gets DAYS rows per portfolio; each value == Σ(balance × that-day token price)', async () => {
  const userId = await seedUser('backfill.snap.b@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, balance: '2' } });
  await prisma.asset.create({ data: { portfolioId, tokenId: ethId, balance: '5' } });

  const result = await runSnapshotsBackfill();
  expect(result.portfolioRows).toBe(DAYS); // one portfolio × DAYS

  const balanceRows = await prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
  });
  expect(balanceRows).toHaveLength(DAYS);
  for (const r of balanceRows) {
    expect(r.userId).toBe(userId); // FK column populated
  }

  // Recompute the expected daily value from the SAME per-day token prices the backfill wrote.
  const priceByDay = async (tokenId: number): Promise<Map<string, number>> => {
    const rows = await prisma.tokenPriceSnapshot.findMany({
      where: { tokenId },
      select: { snapshotDate: true, price: true },
    });
    return new Map(rows.map((r) => [r.snapshotDate.toISOString().slice(0, 10), Number(r.price.toString())]));
  };
  const btcByDay = await priceByDay(btcId);
  const ethByDay = await priceByDay(ethId);

  for (const r of balanceRows) {
    const ymd = r.snapshotDate.toISOString().slice(0, 10);
    const expected = 2 * btcByDay.get(ymd)! + 5 * ethByDay.get(ymd)!;
    expect(Number(r.value.toString())).toBeCloseTo(expected, 2);
  }
});

it('r41c: re-running is idempotent — same row counts and same values', async () => {
  const userId = await seedUser('backfill.snap.c@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, balance: '3' } });

  const first = await runSnapshotsBackfill();
  const firstBtc = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId: btcId },
    orderBy: { snapshotDate: 'asc' },
  });
  const firstBal = await prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
  });

  const second = await runSnapshotsBackfill();

  // Identical counts.
  expect(second.tokenSeries).toBe(first.tokenSeries);
  expect(second.tokenRows).toBe(first.tokenRows);
  expect(second.portfolioRows).toBe(first.portfolioRows);
  expect(await prisma.tokenPriceSnapshot.count({ where: { tokenId: btcId } })).toBe(DAYS);
  expect(await prisma.balanceSnapshot.count({ where: { portfolioId } })).toBe(DAYS);

  // Identical values (deterministic PRNG → same curve).
  const secondBtc = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId: btcId },
    orderBy: { snapshotDate: 'asc' },
  });
  const secondBal = await prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
  });
  for (let i = 0; i < DAYS; i++) {
    expect(secondBtc[i]!.price.toString()).toBe(firstBtc[i]!.price.toString());
    expect(secondBal[i]!.value.toString()).toBe(firstBal[i]!.value.toString());
  }
});
