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
export async function findSnapshotAtOrBefore(
  portfolioId: number,
  cutoffDate: Date,
): Promise<{ value: Prisma.Decimal } | null> {
  return prisma.balanceSnapshot.findFirst({
    where: { portfolioId, snapshotDate: { lte: cutoffDate } },
    orderBy: { snapshotDate: 'desc' },
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
