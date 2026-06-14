import type { BalanceSnapshot } from '@prisma/client';
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
