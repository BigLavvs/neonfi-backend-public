import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  findSnapshotsByPortfolioId,
  countSnapshotsByPortfolioId,
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
