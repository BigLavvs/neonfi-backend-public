// Neonfi backend — Daily Balance Snapshot job tests (Stage 13).
//
// Strategy: real DB (the balance_snapshot TimescaleDB hypertable + Redis-free),
// per-test cleanup. The job has no HTTP surface, so users/subscriptions/
// portfolios/assets are seeded directly via Prisma — no auth/email/Moralis
// machinery. runSnapshotJob() is invoked directly (cron is NODE_ENV-gated off in
// tests). computeDerived is injectable so a single portfolio can be forced to fail
// in isolation (test 299), mirroring token-sync's mock-provider injection.
//
// Tests 296–301 (Stage 13 job) + 321–325 (retrofit-3: derive cache, real
// pnlAllTime, missed detection, cache invalidation).

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { truncateAllUserData } from './helpers.js';
import { runSnapshotJob, RETENTION_SQL } from '../src/jobs/snapshot.job.js';
import { computeDerived } from '../src/modules/portfolios/derive.js';
import { SNAPSHOT_RETENTION_DAYS } from '../src/lib/constants.js';
import { portfolioDerivedCacheKeys } from '../src/lib/portfolio-cache-keys.js';

// ---------------------------------------------------------------------------
// Seeding helpers (direct Prisma — the job reads the DB, not HTTP)
// ---------------------------------------------------------------------------

async function createUser(email: string): Promise<number> {
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const user = await prisma.user.create({
    data: {
      email,
      fullName: 'Snapshot Test User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  return user.id;
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

async function createManualPortfolio(userId: number, name: string): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const portfolio = await prisma.portfolio.create({ data: { userId, name, typeId: type.id } });
  return portfolio.id;
}

// Seeds one BTC asset on the portfolio and returns its expected USD contribution
// (balance × the token's current price, read fresh so the assertion is immune to
// any price drift left by other suites).
async function seedBtcAsset(portfolioId: number, balance: number): Promise<number> {
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  await prisma.asset.create({ data: { portfolioId, tokenId: btc.id, balance } });
  return balance * Number(btc.currentPrice.toString());
}

const todayUtcYmd = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Setup — clear the hypertable FIRST so the cascade-truncate only ever reaches an
// empty balance_snapshot (avoids any TRUNCATE-CASCADE-onto-hypertable edge case).
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
});

// Leave the hypertable empty so no later suite's cascade-truncate is the first to
// hit a non-empty balance_snapshot. Single DELETE, runs once — not the
// beforeEach+afterEach double-TRUNCATE pattern that deadlocks under Neon's pooler.
afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

// ---------------------------------------------------------------------------
// 296: Pro user, one portfolio → one snapshot row for today (UTC)
// ---------------------------------------------------------------------------

it('296: Pro user with one portfolio → one balance_snapshot row dated today (UTC) with the expected totalValue', async () => {
  const userId = await createUser('snap.296@neonfi.test');
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P296');
  const expected = await seedBtcAsset(portfolioId, 2);

  const result = await runSnapshotJob();

  expect(result.snapshotted).toBe(1);
  expect(result.failed).toBe(0);

  const rows = await prisma.balanceSnapshot.findMany();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.portfolioId).toBe(portfolioId);
  expect(row.userId).toBe(userId);
  expect(row.snapshotDate.toISOString().slice(0, 10)).toBe(todayUtcYmd());
  expect(Number(row.value.toString())).toBeCloseTo(expected);
});

// ---------------------------------------------------------------------------
// 297: Free user portfolio is skipped — rows = Pro portfolios only
// ---------------------------------------------------------------------------

it('297: Free user portfolio is NOT snapshotted — total rows equal the number of Pro portfolios', async () => {
  const proUser = await createUser('snap.297.pro@neonfi.test');
  await createProSub(proUser);
  const proPortfolio = await createManualPortfolio(proUser, 'Pro');
  await seedBtcAsset(proPortfolio, 1);

  const freeUser = await createUser('snap.297.free@neonfi.test');
  await createFreeSub(freeUser);
  const freePortfolio = await createManualPortfolio(freeUser, 'Free');
  await seedBtcAsset(freePortfolio, 1);

  const result = await runSnapshotJob();

  expect(result.snapshotted).toBe(1); // only the Pro portfolio
  const rows = await prisma.balanceSnapshot.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.portfolioId).toBe(proPortfolio);

  const freeRows = await prisma.balanceSnapshot.findMany({ where: { portfolioId: freePortfolio } });
  expect(freeRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 298: Idempotency / upsert — twice in one UTC day = one row, rewritten
// ---------------------------------------------------------------------------

it('298: running twice in the same UTC day upserts a single row that reflects the updated total', async () => {
  const userId = await createUser('snap.298@neonfi.test');
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P298');
  const expected1 = await seedBtcAsset(portfolioId, 2);

  await runSnapshotJob();
  let rows = await prisma.balanceSnapshot.findMany({ where: { portfolioId } });
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.value.toString())).toBeCloseTo(expected1);

  // Change the total, then re-run the same UTC day.
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  await prisma.asset.updateMany({ where: { portfolioId }, data: { balance: 5 } });
  const expected2 = 5 * Number(btc.currentPrice.toString());

  const result2 = await runSnapshotJob();
  expect(result2.snapshotted).toBe(1);

  rows = await prisma.balanceSnapshot.findMany({ where: { portfolioId } });
  expect(rows).toHaveLength(1); // composite PK → still exactly one row
  expect(Number(rows[0]!.value.toString())).toBeCloseTo(expected2);
});

// ---------------------------------------------------------------------------
// 299: One portfolio fails in computeDerived → the rest still snapshot
// ---------------------------------------------------------------------------

it('299: one portfolio throwing in computeDerived does not abort the job — failed:1, snapshotted:N-1', async () => {
  const userId = await createUser('snap.299@neonfi.test');
  await createProSub(userId);
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  const p3 = await createManualPortfolio(userId, 'P3');
  await seedBtcAsset(p1, 1);
  await seedBtcAsset(p2, 1);
  await seedBtcAsset(p3, 1);

  // Deriver that throws for p2 only, delegating to the real one otherwise.
  const throwingDerive = async (portfolioId: number) => {
    if (portfolioId === p2) throw new Error('simulated computeDerived failure');
    return computeDerived(portfolioId);
  };

  const result = await runSnapshotJob(throwingDerive);

  expect(result.snapshotted).toBe(2);
  expect(result.failed).toBe(1);

  const rows = await prisma.balanceSnapshot.findMany();
  expect(rows).toHaveLength(2);
  const snapshottedIds = rows.map((r) => r.portfolioId).sort((a, b) => a - b);
  expect(snapshottedIds).toEqual([p1, p3].sort((a, b) => a - b)); // p2 absent
});

// ---------------------------------------------------------------------------
// 300: drop_chunks runs after the loop and uses SNAPSHOT_RETENTION_DAYS
// ---------------------------------------------------------------------------

it('300: drop_chunks runs after snapshotting — dropChunksSucceeded is true and the SQL is built from SNAPSHOT_RETENTION_DAYS', async () => {
  const userId = await createUser('snap.300@neonfi.test');
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId, 'P300');
  await seedBtcAsset(portfolioId, 1);

  const result = await runSnapshotJob();

  // drop_chunks is idempotent: a no-op when nothing is older than the cutoff, but
  // it still must have executed cleanly.
  expect(result.dropChunksSucceeded).toBe(true);

  // The retention SQL targets the hypertable with the 730-day window from the constant.
  expect(SNAPSHOT_RETENTION_DAYS).toBe(730);
  expect(RETENTION_SQL).toContain(String(SNAPSHOT_RETENTION_DAYS));
  expect(RETENTION_SQL).toContain('drop_chunks');
  expect(RETENTION_SQL).toContain('balance_snapshot');
});

// ---------------------------------------------------------------------------
// 301: Multi-portfolio Pro user → one row per portfolio, all dated today
// ---------------------------------------------------------------------------

it('301: a Pro user with 3 portfolios produces 3 snapshot rows in one run, all dated today (UTC) with correct values', async () => {
  const userId = await createUser('snap.301@neonfi.test');
  await createProSub(userId);
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  const p3 = await createManualPortfolio(userId, 'P3');
  const e1 = await seedBtcAsset(p1, 1);
  const e2 = await seedBtcAsset(p2, 2);
  const e3 = await seedBtcAsset(p3, 3);

  const result = await runSnapshotJob();

  expect(result.snapshotted).toBe(3);
  expect(result.failed).toBe(0);

  const rows = await prisma.balanceSnapshot.findMany({ orderBy: { portfolioId: 'asc' } });
  expect(rows).toHaveLength(3);

  const today = todayUtcYmd();
  for (const r of rows) {
    expect(r.snapshotDate.toISOString().slice(0, 10)).toBe(today);
    expect(r.userId).toBe(userId);
  }

  const valueByPortfolio = new Map(rows.map((r) => [r.portfolioId, Number(r.value.toString())]));
  expect(valueByPortfolio.get(p1)!).toBeCloseTo(e1);
  expect(valueByPortfolio.get(p2)!).toBeCloseTo(e2);
  expect(valueByPortfolio.get(p3)!).toBeCloseTo(e3);
});

// ---------------------------------------------------------------------------
// 321-325. retrofit-3 — derive.ts cache + pnlAllTime + missed detection + cache
// invalidation.
// ---------------------------------------------------------------------------

it('321: derive.ts cache HIT — pre-populated portfolio_pnl:<id> is returned without DB recompute', async () => {
  const userId = await createUser('snap.321@neonfi.test');
  const portfolioId = await createManualPortfolio(userId, 'P321');
  // Portfolio has NO assets, so a real compute would yield totalValue 0. Inject a
  // sentinel that only the cached version could have.
  const cachedPayload = {
    totalValue: 9999.99,
    pnlAllTime: 42,
    pnlAllTimeValue: 1234.56,
    pnl24h: 0, pnl24hValue: 0, pnl7d: 0, pnl7dValue: 0, pnl30d: 0, pnl30dValue: 0,
  };
  await redis.set(`portfolio_pnl:${portfolioId}`, JSON.stringify(cachedPayload), 'EX', 300);

  const result = await computeDerived(portfolioId);
  expect(result.totalValue).toBe(9999.99); // sentinel → came from cache, not DB
  expect(result.pnlAllTime).toBe(42);
  expect(result.pnlAllTimeValue).toBe(1234.56);
});

it('322: derive.ts cache MISS — computeDerived writes the computed JSON to portfolio_pnl:<id>', async () => {
  const userId = await createUser('snap.322@neonfi.test');
  const portfolioId = await createManualPortfolio(userId, 'P322');
  await seedBtcAsset(portfolioId, 1);

  await redis.del(`portfolio_pnl:${portfolioId}`); // ensure miss
  const result = await computeDerived(portfolioId);

  const raw = await redis.get(`portfolio_pnl:${portfolioId}`);
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(raw!) as { totalValue: number };
  expect(parsed.totalValue).toBeCloseTo(result.totalValue);
  expect(result.totalValue).toBeGreaterThan(0);
});

it('323: derive.ts pnlAllTime — netDeposit=10000, totalValue=12500 → pnlAllTimeValue=2500, pnlAllTime=25', async () => {
  const userId = await createUser('snap.323@neonfi.test');
  const portfolioId = await createManualPortfolio(userId, 'P323');
  // USDT at price 1.00 → balance 12500 gives totalValue exactly 12500.
  const usdt = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } });
  await prisma.asset.create({ data: { portfolioId, tokenId: usdt.id, balance: '12500' } });
  await prisma.portfolio.update({ where: { id: portfolioId }, data: { netDeposit: '10000' } });

  await redis.del(`portfolio_pnl:${portfolioId}`); // force compute
  const result = await computeDerived(portfolioId);

  expect(result.totalValue).toBeCloseTo(12500);
  expect(result.pnlAllTimeValue).toBeCloseTo(2500);
  expect(result.pnlAllTime).toBeCloseTo(25);
});

it('324: snapshot.job missed detection — 2 Pro portfolios, one throws → snapshotted=1, failed=1, missed=0', async () => {
  const userId = await createUser('snap.324@neonfi.test');
  await createProSub(userId);
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  await seedBtcAsset(p1, 1);
  await seedBtcAsset(p2, 1);

  // p2 throws during derive; the failure is caught → counted under `failed`, NOT
  // `missed`. `missed` only counts Pro portfolios the loop never reached.
  const throwingDerive = async (portfolioId: number) => {
    if (portfolioId === p2) throw new Error('simulated computeDerived failure');
    return computeDerived(portfolioId);
  };

  const result = await runSnapshotJob(throwingDerive);

  expect(result.snapshotted).toBe(1);
  expect(result.failed).toBe(1);
  expect(typeof result.missed).toBe('number');
  expect(result.missed).toBe(0);
});

it('325: snapshot.job PnL cache invalidation — redis.del called with portfolioDerivedCacheKeys per snapshotted portfolio', async () => {
  const userId = await createUser('snap.325@neonfi.test');
  await createProSub(userId);
  const p1 = await createManualPortfolio(userId, 'P1');
  const p2 = await createManualPortfolio(userId, 'P2');
  await seedBtcAsset(p1, 1);
  await seedBtcAsset(p2, 1);

  const delSpy = vi.spyOn(redis, 'del');
  try {
    const result = await runSnapshotJob();
    expect(result.snapshotted).toBe(2);
    // Stage 14: the per-upsert hook deletes the full derived-cache key set (PnL +
    // 3 analytics keys) in one variadic redis.del call, once per portfolio.
    expect(delSpy).toHaveBeenCalledWith(...portfolioDerivedCacheKeys(p1));
    expect(delSpy).toHaveBeenCalledWith(...portfolioDerivedCacheKeys(p2));
  } finally {
    delSpy.mockRestore();
  }
});
