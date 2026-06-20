// retrofit-84/86 (H13/H13.1) — one-off, idempotent reclassification of EXISTING NFT rows against the
// multi-signal spam classifier.
//
// retrofit-73 persisted Moralis' possible_spam and filtered on it, but it under-flags airdrop spam,
// and the retrofit-84 migration defaults every pre-existing row to spam=false. This backfill
// re-evaluates each row with the signals computable WITHOUT a network call (via the shared
// classifyNftSpam):
//   - the row's stored possible_spam flag (a provider already flagged it),
//   - the curated known-spam blocklist (Garbage Bags / Hefty Presents) — catches provider-missed
//     spam offline (retrofit-86),
//   - the BULK held-count from the DB (≥ NFT_BULK_SPAM_MIN copies of one contract in the wallet),
//   - the conservative name/collection heuristic (URLs, "claim"/"reward"/"voucher"/"$<amount>", …),
//   - the legit/utility ALLOWLIST (Uniswap V3 positions / ENS / POAP) — never flagged.
// Any spam hit → spam=true. We only ever SET spam=true here (never flip back to false), so the
// script is monotonic + fully idempotent and never undoes a sync-time verdict.
//
// What needs a resync (NOT offline): the cross-provider spam-contract DB (GoldRush per-wallet
// is_spam / the plan-gated Alchemy list) — applied on the NEXT resync (sync.importNftHoldings). The
// transfer-based airdrop signal isn't computed at all (we have no per-NFT transfer rows). This
// script gives immediate relief for the blocklist / bulk / name / already-flagged cases.
//
// Run: `npm run reclassify:nft-spam`  (add `-- --dry-run` to preview counts without writing).

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { classifyNftSpam } from '../modules/wallet-data/nft-spam.js';

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

  // Bulk signal needs the TRUE held count per (portfolio, contract), counted across ALL rows (not
  // just the not-yet-flagged ones), so a partially-flagged bulk contract still scores correctly.
  const counts = await prisma.nft.groupBy({
    by: ['portfolioId', 'contractAddress'],
    _count: { _all: true },
  });
  const heldByKey = new Map<string, number>();
  for (const g of counts) {
    heldByKey.set(`${g.portfolioId}:${g.contractAddress.toLowerCase()}`, g._count._all);
  }

  // Only rows not already flagged — keeps the work (and the marked count) idempotent on re-run.
  const rows = await prisma.nft.findMany({
    where: { spam: false },
    select: { id: true, portfolioId: true, name: true, collectionName: true, possibleSpam: true, contractAddress: true },
  });

  const toMark: number[] = [];
  for (const r of rows) {
    const heldCount = heldByKey.get(`${r.portfolioId}:${r.contractAddress.toLowerCase()}`) ?? 1;
    // spamContract omitted (provider DB needs the network/resync); classifyNftSpam still applies the
    // blocklist, allowlist, bulk held-count, and name heuristic offline.
    const spam = classifyNftSpam({
      possibleSpam: r.possibleSpam,
      name: r.name,
      collectionName: r.collectionName,
      contractAddress: r.contractAddress,
      heldCount,
    });
    if (spam) toMark.push(r.id);
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
