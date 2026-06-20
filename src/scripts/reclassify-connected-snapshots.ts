// retrofit-78 N3 — one-off, idempotent reclassification of EXISTING connected backfill snapshots.
//
// retrofit-77 added BalanceSnapshot.approx and made the short-term (24h/7d/30d) baseline lookup
// ignore approx rows, but its migration left every PRE-EXISTING row approx=false on the assumption
// "long-lived portfolios already have real daily snapshots winning the match." That holds for 24h
// (the daily job, running since ~the migration date, writes a real ≤24h snapshot), but NOT for
// 7d/30d: the only snapshots that old are the APPROXIMATE multi-year initial-sync backfill
// (sync.ts buildConnectedValueHistory — historical balance × ~today's price), and they're
// approx=false, so findSnapshotAtOrBefore happily uses one as a 7d/30d baseline. Live symptom on a
// real $16 wallet: pnl30dValue = 16.24 − 215.54 (a spaced May-20 backfill row) = −$203 / −94% — pure
// fiction.
//
// Fix (per the retrofit-78 plan): for each CONNECTED portfolio, the trailing run of CONSECUTIVE
// daily snapshots (the real daily-job streak ending at the latest snapshot) is real → left
// untouched; every snapshot OLDER than that run (the spaced backfill) is marked approx=true. We
// only ever SET approx=true (never flip back to false), so this never undoes retrofit-77's write-time
// flags and is fully idempotent. Manual portfolios are not connected and are skipped entirely (their
// snapshots come only from the daily job + retrofit-76, all genuinely real).
//
// Why "older than the trailing daily run" is the right cut: the newest row is never itself a
// short-term baseline (findSnapshotAtOrBefore needs snapshotDate ≤ today−Ndays, and the newest row
// is "today"), so leaving a lone newest backfill row as-is is harmless; what matters is that the
// rows AT 7-/30-days-ago stop being eligible. After this runs, connected 7d/30d read "—"/0 until real
// daily history accrues — honest — while 24h (real Jun-19-style snapshot) and all-time (earliest
// snapshot, which findEarliestSnapshotByPortfolio reads regardless of approx) are unchanged.
//
// Run: `npm run reclassify:snapshots`  (add `-- --dry-run` to preview counts without writing).

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';

const DAY_MS = 86_400_000;

export interface ReclassifyResult {
  portfolios: number; // connected portfolios examined
  touched: number; // connected portfolios that had ≥1 row reclassified
  rowsMarked: number; // backfill rows flipped approx=false → true
  dryRun: boolean;
}

/**
 * Mark every connected portfolio's pre-daily-run backfill snapshots approx=true. Idempotent
 * (monotonic: only false→true, scoped to rows strictly older than the trailing consecutive-daily
 * run). dryRun counts what WOULD be flipped and writes nothing.
 */
export async function runReclassifyConnectedSnapshots(
  opts: { dryRun?: boolean } = {},
): Promise<ReclassifyResult> {
  const dryRun = opts.dryRun ?? false;

  const portfolios = await prisma.portfolio.findMany({
    where: { type: { name: 'connected' } },
    select: { id: true },
  });

  let rowsMarked = 0;
  const touchedIds: number[] = [];

  for (const { id: portfolioId } of portfolios) {
    // Newest → oldest. Only the date + flag are needed to find the trailing daily run.
    const rows = await prisma.balanceSnapshot.findMany({
      where: { portfolioId },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true },
    });
    if (rows.length === 0) continue;

    // Walk from the newest while each row is exactly one day before the previous — that streak is
    // the real daily-job output. `runEnd` is the index of the OLDEST row still in the streak.
    let runEnd = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i - 1]!.snapshotDate.getTime() - rows[i]!.snapshotDate.getTime();
      if (gap === DAY_MS) runEnd = i;
      else break;
    }
    const runOldestDate = rows[runEnd]!.snapshotDate;

    // Everything strictly older than the streak is spaced backfill → approx=true. Scope to
    // approx=false so the returned count is the rows actually flipped (idempotent: 0 on re-run).
    const where = {
      portfolioId,
      approx: false,
      snapshotDate: { lt: runOldestDate },
    } as const;

    if (dryRun) {
      const would = await prisma.balanceSnapshot.count({ where });
      if (would > 0) {
        touchedIds.push(portfolioId);
        rowsMarked += would;
        console.log(JSON.stringify({
          event: 'reclassify_connected_preview',
          portfolioId,
          dailyRunLength: runEnd + 1,
          runOldestDate: runOldestDate.toISOString().slice(0, 10),
          wouldMark: would,
        }));
      }
      continue;
    }

    const { count } = await prisma.balanceSnapshot.updateMany({ where, data: { approx: true } });
    if (count > 0) {
      touchedIds.push(portfolioId);
      rowsMarked += count;
    }
  }

  // Bust the derived (portfolio_pnl + analytics_*) caches for touched portfolios so the next read
  // recomputes 7d/30d off the corrected baseline. Best-effort — a Redis hiccup must not fail the
  // reclassification. (No write happened in dryRun, so nothing to invalidate.)
  if (!dryRun && touchedIds.length > 0) {
    const keys = touchedIds.flatMap((id) => portfolioDerivedCacheKeys(id));
    if (keys.length > 0) await redis.del(...keys).catch(() => { /* best-effort */ });
  }

  const result: ReclassifyResult = {
    portfolios: portfolios.length,
    touched: touchedIds.length,
    rowsMarked,
    dryRun,
  };
  console.log(JSON.stringify({
    event: dryRun ? 'reclassify_connected_dryrun_done' : 'reclassify_connected_done',
    ...result,
  }));
  return result;
}

// CLI entry (mirrors backfill-costbasis.ts). Only runs when invoked directly, NOT when imported by
// a test — pathToFileURL(argv[1]) is the cross-platform ESM main-module check (handles Windows
// `file:///C:/…`).
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  runReclassifyConnectedSnapshots({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[reclassify:snapshots] failed:', e);
      process.exit(1);
    });
}
