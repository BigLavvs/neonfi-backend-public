import { Prisma, type BalanceSnapshot } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export interface ListSnapshotsFilter {
  limit: number;
  offset: number;
}

// Newest-first (snapshotDate DESC) — matches the typical chart-rendering pattern
// that fetches the latest dates and reverses for display (retrofit-3 §1.2).
export async function findSnapshotsByPortfolioId(
  portfolioId: number,
  filters: ListSnapshotsFilter,
): Promise<BalanceSnapshot[]> {
  return prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'desc' },
    take: filters.limit,
    skip: filters.offset,
  });
}

export async function countSnapshotsByPortfolioId(portfolioId: number): Promise<number> {
  return prisma.balanceSnapshot.count({ where: { portfolioId } });
}

// Stage 14 (§1.7): most recent snapshot at or before `cutoffDate`. Used by the
// analytics summary endpoint for pnl7d / pnl30d via findSnapshotNearDaysAgo.
//
// retrofit-77 (N1): this is the SHORT-TERM (24h/7d/30d) baseline lookup, so it filters to
// approx=false — a backfilled ESTIMATE (connected initial-sync net-worth-at-block) must never
// stand in as a recent-performance baseline. A freshly-synced wallet whose only ≤N-day rows are
// approx returns null here → the caller renders "—" (0) until real snapshots accrue, instead of a
// garbage delta off an inflated estimate. (All-time PnL still reads approx rows — see H11/r78.)
export async function findSnapshotAtOrBefore(
  portfolioId: number,
  cutoffDate: Date,
): Promise<{ value: Prisma.Decimal; snapshotDate: Date } | null> {
  // retrofit-72 (H5): snapshotDate is returned too so findSnapshotNearDaysAgo can reject a
  // baseline that's much older than the target window (a stale delta mislabeled "24H").
  return prisma.balanceSnapshot.findFirst({
    where: { portfolioId, approx: false, snapshotDate: { lte: cutoffDate } },
    orderBy: { snapshotDate: 'desc' },
    select: { value: true, snapshotDate: true },
  });
}

// retrofit-58: the EARLIEST recorded snapshot (oldest date) — the baseline for a connected
// portfolio's all-time PnL ("growth since tracking began", derive.ts). A windowed transfer
// import gives connected wallets no trustworthy cost basis, so all-time is measured against
// the first snapshot we ever recorded rather than netDeposit. Null when none exists yet.
export async function findEarliestSnapshotByPortfolio(
  portfolioId: number,
): Promise<{ value: Prisma.Decimal } | null> {
  return prisma.balanceSnapshot.findFirst({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
    select: { value: true },
  });
}

// Stage 14 (§1.7): all snapshots ASC by date — for the performance chart. The
// AreaChart consumes points left-to-right, so ascending order is the natural fit
// (the paginated DESC list above serves a different, table-style consumer).
export async function findAllSnapshotsAscByPortfolio(
  portfolioId: number,
): Promise<Array<{ snapshotDate: Date; value: Prisma.Decimal }>> {
  return prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, value: true },
  });
}
