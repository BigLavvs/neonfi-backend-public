// retrofit-38 — one-off, idempotent average-cost backfill.
//
// retrofit-27 added the avg-cost columns (Asset.avgCost / costBasis / realizedPnl) and
// recalcAssetBalance, but recalc only runs on transaction create/update/delete. Assets +
// transactions created BEFORE retrofit-27 were never recomputed, so their avgCost/costBasis
// stayed null/0 → costTracked false → the analytics page shows "—" / "$0.00" even though
// real priced Bought rows exist. This script recomputes every asset from its real history
// using the EXISTING recalc functions verbatim (no new cost logic), so the backfill matches
// live behaviour exactly. Safe by construction: a cost-less opening lot (null openingCostBasis,
// no priced buys) recomputes to avgCost = null (correctly stays untracked); priced buys yield
// the weighted avgCost + costBasis. Idempotent — re-running produces the same state.
//
// Run: `npm run backfill:costbasis`  (add `-- --dry-run` to preview without writing).

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';
import {
  recalcAssetBalance,
  recalcPortfolioNetDeposit,
} from '../modules/transactions/recalc.js';

export interface BackfillResult {
  assets: number;
  portfolios: number;
  dryRun: boolean;
}

// Thrown to roll back the dry-run transaction once the recomputed values have been read —
// recalc runs exactly as it would live, but nothing is persisted.
class DryRunRollback extends Error {}

/**
 * Recompute every asset's avg-cost/costBasis/realizedPnl/netDeposit from its real history.
 * Reuses recalc.ts verbatim inside one interactive transaction per asset (deterministic,
 * matches the live create/update/delete path). Idempotent.
 *
 * dryRun: log a per-asset before/after diff and roll back — no writes, no cache busting.
 */
export async function runCostBasisBackfill(opts: { dryRun?: boolean } = {}): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;

  const assets = await prisma.asset.findMany({
    select: {
      portfolioId: true,
      tokenId: true,
      avgCost: true,
      costBasis: true,
      token: { select: { symbol: true } },
    },
  });

  let updated = 0;
  for (const a of assets) {
    if (dryRun) {
      try {
        await prisma.$transaction(async (tx) => {
          await recalcAssetBalance(tx, a.portfolioId, a.tokenId);
          await recalcPortfolioNetDeposit(tx, a.portfolioId);
          const after = await tx.asset.findUnique({
            where: { portfolioId_tokenId: { portfolioId: a.portfolioId, tokenId: a.tokenId } },
            select: { avgCost: true, costBasis: true },
          });
          console.log(JSON.stringify({
            event: 'costbasis_backfill_preview',
            symbol: a.token.symbol,
            portfolioId: a.portfolioId,
            before: { avgCost: a.avgCost?.toString() ?? null, costBasis: a.costBasis.toString() },
            after: {
              avgCost: after?.avgCost?.toString() ?? null,
              costBasis: after?.costBasis?.toString() ?? null,
            },
          }));
          throw new DryRunRollback();
        });
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e; // real error — let it surface
      }
    } else {
      await prisma.$transaction(async (tx) => {
        await recalcAssetBalance(tx, a.portfolioId, a.tokenId);
        await recalcPortfolioNetDeposit(tx, a.portfolioId);
      });
    }
    updated++;
  }

  const portfolioIds = [...new Set(assets.map((a) => a.portfolioId))];

  // Invalidate the derived caches (portfolio_pnl + analytics_*) so the next read recomputes
  // from the backfilled columns — the analytics page is exactly the symptom. Uses the shared
  // helper (superset of the spec's portfolio_pnl) to stay in sync with every other callsite.
  if (!dryRun) {
    const keys = portfolioIds.flatMap((id) => portfolioDerivedCacheKeys(id));
    if (keys.length > 0) await redis.del(...keys).catch(() => { /* best-effort */ });
  }

  console.log(JSON.stringify({
    event: dryRun ? 'costbasis_backfill_dryrun_done' : 'costbasis_backfill_done',
    assets: updated,
    portfolios: portfolioIds.length,
  }));

  return { assets: updated, portfolios: portfolioIds.length, dryRun };
}

// CLI entry (mirrors src/scripts/seed-catalog.ts). Only runs when invoked directly, NOT when
// imported by a test — pathToFileURL(argv[1]) is the standard, cross-platform ESM main-module
// check (handles Windows `file:///C:/…` correctly).
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  runCostBasisBackfill({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[backfill:costbasis] failed:', e);
      process.exit(1);
    });
}
