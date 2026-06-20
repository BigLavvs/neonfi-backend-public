// Neonfi backend — retrofit-78 N3: reclassify existing connected backfill snapshots (approx=true).
//
// retrofit-77 left pre-existing rows approx=false; for connected portfolios the spaced multi-year
// backfill at 7-/30-days-ago was therefore still eligible as a short-term baseline (live −94% 30d).
// This script marks every connected snapshot OLDER than the trailing consecutive-daily run
// approx=true, leaving the real daily streak and all manual portfolios untouched. Idempotent.

import { it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAllUserData } from './helpers.js';
import { runReclassifyConnectedSnapshots } from '../src/scripts/reclassify-connected-snapshots.js';

let ethChainId: number;
let connectedTypeId: number;
let manualTypeId: number;
let authProviderId: number;
let onboardingId: number;

const DAY_MS = 86_400_000;
const todayUtcMs = (): number =>
  new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
const dateDaysAgo = (n: number): Date => new Date(todayUtcMs() - n * DAY_MS);

let userSeq = 0;
async function makeUser(): Promise<number> {
  userSeq++;
  const u = await prisma.user.create({
    data: {
      email: `reclassify.${userSeq}@neonfi.test`,
      passwordHash: 'x',
      fullName: 'Reclassify User',
      authProviderId,
      onboardingStatusId: onboardingId,
    },
  });
  return u.id;
}

let walletSeq = 0;
async function makeConnectedPortfolio(userId: number): Promise<number> {
  walletSeq++;
  const p = await prisma.portfolio.create({
    data: {
      userId,
      name: `C${walletSeq}`,
      typeId: connectedTypeId,
      chainId: ethChainId,
      walletAddress: `0x${walletSeq.toString(16).padStart(40, '0')}`,
    },
  });
  return p.id;
}

async function makeManualPortfolio(userId: number): Promise<number> {
  const p = await prisma.portfolio.create({ data: { userId, name: 'M', typeId: manualTypeId } });
  return p.id;
}

// Seed a snapshot `daysAgo` days back. approx defaults false (the pre-retrofit-78 state).
async function seedSnap(
  portfolioId: number,
  userId: number,
  daysAgo: number,
  approx = false,
  value = '100',
): Promise<void> {
  await prisma.balanceSnapshot.create({
    data: { portfolioId, userId, snapshotDate: dateDaysAgo(daysAgo), value, approx },
  });
}

async function approxByDaysAgo(portfolioId: number): Promise<Map<number, boolean>> {
  const rows = await prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    select: { snapshotDate: true, approx: true },
  });
  const base = todayUtcMs();
  return new Map(
    rows.map((r) => [Math.round((base - r.snapshotDate.getTime()) / DAY_MS), r.approx]),
  );
}

beforeAll(async () => {
  const [chain, connected, manual, auth, onboarding] = await Promise.all([
    prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } }),
    prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } }),
    prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } }),
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  ethChainId = chain.id;
  connectedTypeId = connected.id;
  manualTypeId = manual.id;
  authProviderId = auth.id;
  onboardingId = onboarding.id;
});

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
});

afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

it('r78-N3: a connected portfolio — spaced backfill becomes approx=true, the trailing daily run stays false', async () => {
  const userId = await makeUser();
  const p = await makeConnectedPortfolio(userId);
  // Real daily streak: today, 1d, 2d (consecutive). Spaced backfill: 10d, 40d.
  await seedSnap(p, userId, 0);
  await seedSnap(p, userId, 1);
  await seedSnap(p, userId, 2);
  await seedSnap(p, userId, 10);
  await seedSnap(p, userId, 40);

  const res = await runReclassifyConnectedSnapshots();
  expect(res.rowsMarked).toBe(2); // 10d + 40d
  expect(res.touched).toBe(1);

  const flags = await approxByDaysAgo(p);
  expect(flags.get(0)).toBe(false); // daily run untouched
  expect(flags.get(1)).toBe(false);
  expect(flags.get(2)).toBe(false);
  expect(flags.get(10)).toBe(true); // spaced backfill marked
  expect(flags.get(40)).toBe(true);
});

it('r78-N3: manual portfolios are never touched (only connected)', async () => {
  const userId = await makeUser();
  const m = await makeManualPortfolio(userId);
  // Even spaced manual snapshots stay approx=false — manual history is all real (daily job / r76).
  await seedSnap(m, userId, 0);
  await seedSnap(m, userId, 9);
  await seedSnap(m, userId, 35);

  const res = await runReclassifyConnectedSnapshots();
  expect(res.rowsMarked).toBe(0);

  const flags = await approxByDaysAgo(m);
  expect([...flags.values()].every((a) => a === false)).toBe(true);
});

it('r78-N3: a fully-consecutive connected portfolio (all real daily) marks nothing', async () => {
  const userId = await makeUser();
  const p = await makeConnectedPortfolio(userId);
  await seedSnap(p, userId, 0);
  await seedSnap(p, userId, 1);
  await seedSnap(p, userId, 2);
  await seedSnap(p, userId, 3);

  const res = await runReclassifyConnectedSnapshots();
  expect(res.rowsMarked).toBe(0);
  const flags = await approxByDaysAgo(p);
  expect([...flags.values()].every((a) => a === false)).toBe(true);
});

it('r78-N3: idempotent — a second run marks 0 additional rows', async () => {
  const userId = await makeUser();
  const p = await makeConnectedPortfolio(userId);
  await seedSnap(p, userId, 0);
  await seedSnap(p, userId, 1);
  await seedSnap(p, userId, 15);

  const first = await runReclassifyConnectedSnapshots();
  expect(first.rowsMarked).toBe(1); // 15d
  const second = await runReclassifyConnectedSnapshots();
  expect(second.rowsMarked).toBe(0);
  expect(second.touched).toBe(0);

  const flags = await approxByDaysAgo(p);
  expect(flags.get(15)).toBe(true);
  expect(flags.get(0)).toBe(false);
  expect(flags.get(1)).toBe(false);
});

it('r78-N3: --dry-run counts what would change but writes nothing', async () => {
  const userId = await makeUser();
  const p = await makeConnectedPortfolio(userId);
  await seedSnap(p, userId, 0);
  await seedSnap(p, userId, 1);
  await seedSnap(p, userId, 12);
  await seedSnap(p, userId, 50);

  const res = await runReclassifyConnectedSnapshots({ dryRun: true });
  expect(res.dryRun).toBe(true);
  expect(res.rowsMarked).toBe(2); // 12d + 50d would flip

  // Nothing actually changed.
  const flags = await approxByDaysAgo(p);
  expect([...flags.values()].every((a) => a === false)).toBe(true);
});

it('r78-N3: real daily run already approx=false is preserved; pre-marked backfill stays true (no flip-back)', async () => {
  const userId = await makeUser();
  const p = await makeConnectedPortfolio(userId);
  await seedSnap(p, userId, 0); // real
  await seedSnap(p, userId, 1); // real
  await seedSnap(p, userId, 20, true); // already approx=true (e.g. a post-r77 backfill row)

  const res = await runReclassifyConnectedSnapshots();
  expect(res.rowsMarked).toBe(0); // 20d already true → not re-counted

  const flags = await approxByDaysAgo(p);
  expect(flags.get(0)).toBe(false);
  expect(flags.get(1)).toBe(false);
  expect(flags.get(20)).toBe(true);
});
