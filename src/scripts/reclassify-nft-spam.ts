// retrofit-84 (H13) — one-off, idempotent reclassification of EXISTING NFT rows against the new
// multi-signal spam classifier.
//
// retrofit-73 persisted Moralis' possible_spam and filtered on it, but it under-flags airdrop spam,
// and the retrofit-84 migration defaults every pre-existing row to spam=false. This backfill
// re-evaluates each row with the signals available WITHOUT a network call:
//   - the row's stored possible_spam flag (a provider already flagged it), OR
//   - the conservative name/collection heuristic (URLs, "claim"/"reward"/"voucher"/"$<amount>", …).
// Any hit → spam=true. We only ever SET spam=true here (never flip back to false), so the script is
// monotonic + fully idempotent and never undoes a sync-time verdict.
//
// The cross-provider spam-contract DB (Alchemy getSpamContracts) needs the wallet/chain context and
// is applied on the NEXT resync (sync.importNftHoldings) — so a resync remains the way to catch the
// provider-only spam ("Garbage Bags" / "Hefty Presents") that has no telltale name. This script
// gives immediate relief for the name/heuristic + already-flagged cases.
//
// Run: `npm run reclassify:nft-spam`  (add `-- --dry-run` to preview counts without writing).

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { isHeuristicNftSpam } from '../modules/wallet-data/nft-spam.js';

export interface ReclassifyNftSpamResult {
  scanned: number; // NFT rows examined (currently spam=false)
  marked: number; // rows flipped spam=false → true
  dryRun: boolean;
}

/**
 * Re-flag existing spam=false NFT rows as spam when a stored provider flag (possibleSpam) or the
 * name/collection heuristic trips. Idempotent (only false→true). dryRun counts without writing.
 */
export async function runReclassifyNftSpam(
  opts: { dryRun?: boolean } = {},
): Promise<ReclassifyNftSpamResult> {
  const dryRun = opts.dryRun ?? false;

  // Only rows not already flagged — keeps the work (and the marked count) idempotent on re-run.
  const rows = await prisma.nft.findMany({
    where: { spam: false },
    select: { id: true, name: true, collectionName: true, possibleSpam: true },
  });

  const toMark: number[] = [];
  for (const r of rows) {
    if (r.possibleSpam || isHeuristicNftSpam(r.name, r.collectionName)) toMark.push(r.id);
  }

  if (!dryRun && toMark.length > 0) {
    // Chunk the updateMany so the IN list stays bounded on large wallets.
    const CHUNK = 1000;
    for (let i = 0; i < toMark.length; i += CHUNK) {
      const ids = toMark.slice(i, i + CHUNK);
      await prisma.nft.updateMany({ where: { id: { in: ids } }, data: { spam: true } });
    }
  }

  const result: ReclassifyNftSpamResult = {
    scanned: rows.length,
    marked: toMark.length,
    dryRun,
  };
  console.log(JSON.stringify({
    event: dryRun ? 'reclassify_nft_spam_dryrun_done' : 'reclassify_nft_spam_done',
    ...result,
  }));
  return result;
}

// CLI entry (mirrors reclassify-connected-snapshots.ts). Only runs when invoked directly, NOT when
// imported by a test — pathToFileURL(argv[1]) is the cross-platform ESM main-module check.
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  runReclassifyNftSpam({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[reclassify:nft-spam] failed:', e);
      process.exit(1);
    });
}
