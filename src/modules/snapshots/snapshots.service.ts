import type { Prisma } from '@prisma/client';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  findSnapshotsByPortfolioId,
  countSnapshotsByPortfolioId,
  findSnapshotAtOrBefore,
  type ListSnapshotsFilter,
} from './snapshots.repository.js';
import { toSnapshotDTO, type SnapshotDTO } from './snapshots.dto.js';

// The Snapshot module owns BalanceSnapshot (architecture line 1230). It reads ONLY
// its own table; portfolio ownership is enforced upstream by the controller's
// ownership middleware (retrofit-3 §1.4). No cross-module table reads here.
export async function listPortfolioSnapshots(
  portfolio: PortfolioWithRelations,
  filters: ListSnapshotsFilter,
): Promise<{ snapshots: SnapshotDTO[]; meta: { limit: number; offset: number; total: number } }> {
  const [snapshots, total] = await Promise.all([
    findSnapshotsByPortfolioId(portfolio.id, filters),
    countSnapshotsByPortfolioId(portfolio.id),
  ]);
  return {
    snapshots: snapshots.map(toSnapshotDTO),
    meta: { limit: filters.limit, offset: filters.offset, total },
  };
}

/**
 * Stage 14 (§1.7): the most recent snapshot at or before `today - daysAgo`. Used
 * by the analytics summary endpoint for pnl7d / pnl30d. Returns null if no snapshot
 * exists in that window (new portfolio, gap in retention, etc.) — the caller treats
 * null as "no historical comparison available" and returns 0 for both fields.
 *
 * The snapshot column is `@db.Date` so PostgreSQL stores midnight-UTC. We construct
 * the cutoff at UTC midnight too (matching snapshot.job.ts's todayUtcDate) — never
 * local-time `setDate` arithmetic, which drifts across timezone boundaries.
 */
export async function findSnapshotNearDaysAgo(
  portfolioId: number,
  daysAgo: number,
): Promise<{ value: Prisma.Decimal } | null> {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const today = new Date(`${todayYmd}T00:00:00.000Z`);
  const cutoff = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return findSnapshotAtOrBefore(portfolioId, cutoff);
}

// Re-export the repository helper as a service-layer call so the analytics module
// reads snapshot data only through the Snapshot module's service (architecture line
// 1262-1263 module isolation). No date math needed here — the ASC timeseries is
// returned as-is for the performance chart.
export { findAllSnapshotsAscByPortfolio } from './snapshots.repository.js';
