// retrofit-85 (H11 deep) — one-off rebuild of EXISTING connected portfolios' value history with
// REAL provider-sourced historical value.
//
// Before retrofit-85, the connected value-history backfill wrote EVERY historical point as
// approx=true ("historical balance × ~today's price"), even though the one-call providers
// (GoldRush portfolio_v2?days=1095, Zerion, Mobula) actually return value at HISTORICAL prices
// (live-probe confirmed: portfolio_v2 reconstructs per-day balances + that-day quote_rate over 3
// years). retrofit-85 now tags provider-priced points approx=false and only the Moralis to_block
// tail approx=true, and writes via an approx-guarded upsert.
//
// A normal resync stays INCREMENTAL (today only — retrofit-60 C2) so it never re-pulls the
// multi-year series; this script is how EXISTING portfolios get their old approx=true estimates
// upgraded to accurate provider history. It re-pulls the provider series per connected portfolio and
// upserts with the guard, so:
//   - provider-covered days flip approx=true → approx=false (accurate, solid line),
//   - days only the Moralis tail can fill stay approx=true (honest dashed estimate),
//   - REAL daily-job rows (approx=false) are never touched.
// Idempotent (re-running converges to the same provider series). Best-effort per portfolio.
//
// Run: `npm run rebuild:connected-history`  (add `-- --dry-run` to list portfolios without writing).

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { rebuildConnectedHistory } from '../modules/wallet-data/sync.js';

export interface RebuildConnectedHistoryResult {
  portfolios: number; // connected portfolios examined
  rebuilt: number; // portfolios whose history was re-pulled (had address + chain)
  dryRun: boolean;
}

export async function runRebuildConnectedHistory(
  opts: { dryRun?: boolean } = {},
): Promise<RebuildConnectedHistoryResult> {
  const dryRun = opts.dryRun ?? false;

  const portfolios = await prisma.portfolio.findMany({
    where: { type: { name: 'connected' } },
    include: { type: true, chain: true },
  });

  let rebuilt = 0;
  for (const portfolio of portfolios) {
    if (dryRun) {
      const eligible = Boolean(portfolio.walletAddress && portfolio.chain?.slug);
      if (eligible) rebuilt += 1;
      console.log(JSON.stringify({
        event: 'rebuild_connected_history_preview',
        portfolioId: portfolio.id,
        chain: portfolio.chain?.slug ?? null,
        eligible,
      }));
      continue;
    }
    try {
      const did = await rebuildConnectedHistory(portfolio);
      if (did) rebuilt += 1;
      console.log(JSON.stringify({ event: 'rebuild_connected_history_one', portfolioId: portfolio.id, rebuilt: did }));
    } catch (e) {
      console.error('[rebuild:connected-history] portfolio failed', portfolio.id, (e as Error).message);
    }
  }

  const result: RebuildConnectedHistoryResult = { portfolios: portfolios.length, rebuilt, dryRun };
  console.log(JSON.stringify({
    event: dryRun ? 'rebuild_connected_history_dryrun_done' : 'rebuild_connected_history_done',
    ...result,
  }));
  return result;
}

// CLI entry (mirrors reclassify-connected-snapshots.ts). Runs only when invoked directly.
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  runRebuildConnectedHistory({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[rebuild:connected-history] failed:', e);
      process.exit(1);
    });
}
