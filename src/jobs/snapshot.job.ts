// Neonfi backend — Daily Balance Snapshot job (Stage 13).
//
// Writes one BalanceSnapshot per Pro portfolio per UTC day into the TimescaleDB
// `balance_snapshot` hypertable, then prunes chunks older than the retention
// window. Two responsibilities, one daily run (default midnight UTC).
//
// IDEMPOTENT PER UTC DAY via the composite PK (portfolioId, snapshotDate): a
// same-day re-run OVERWRITES today's row (an explicit rewrite, not a no-op — lets
// an operator re-snapshot after fixing a momentarily-bad price), never a second row.
//
// PRO-ONLY: free users get no historical chart, so no snapshots. Plan is read via
// getEffectivePlan() (the soft helper) so a cancelled-but-still-in-period user is
// treated as Pro and an expired one as free. History is NEVER deleted on downgrade
// — retention (drop_chunks) is the only pruner.
//
// FAILURE ISOLATION: one portfolio throwing (e.g. a missing Token row) is logged
// and skipped; the loop continues. A drop_chunks failure is logged but does not
// abort or "poison" the next run.
//
// Scheduling mirrors token-sync.job.ts: node-cron, gated by SNAPSHOT_ENABLED, and
// only started outside tests (src/index.ts, NODE_ENV !== 'test'). Tests invoke
// runSnapshotJob() directly.

import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { config } from '../lib/config.js';
import { SNAPSHOT_RETENTION_DAYS } from '../lib/constants.js';
import { getEffectivePlan } from '../modules/subscriptions/subscriptions.service.js';
import { listAllPortfolioIdsForJobs } from '../modules/portfolios/portfolios.service.js';
import { computeDerived } from '../modules/portfolios/derive.js';
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';

export interface SnapshotJobResult {
  snapshotted: number;
  failed: number;
  // Pro portfolios that should have been snapshotted but weren't (retrofit-3 §1.7,
  // architecture line 1222 "flag and alert on missed snapshots").
  missed: number;
  dropChunksSucceeded: boolean;
}

// drop_chunks retention cutoff, built from the typed constant (NOT user input — so
// the $queryRawUnsafe interpolation is safe). The partition column `snapshotDate`
// is a `date`, so the cutoff MUST be cast to date: passing a raw `timestamptz`
// (`NOW() - INTERVAL '730 days'`) makes Neon's TimescaleDB reject it with
// SQLSTATE 22023 ("invalid time argument type ... Try casting the argument to
// date"). drop_chunks is a set-returning function, hence $queryRawUnsafe (the same
// reason prisma/sql/run-hypertable.ts uses queryRaw for create_hypertable).
export const RETENTION_SQL =
  `SELECT drop_chunks('balance_snapshot', (NOW() - INTERVAL '${SNAPSHOT_RETENTION_DAYS} days')::date)`;

// Today's date at UTC midnight. The column is `date` (@db.Date), so this pins the
// row to an unambiguous calendar day regardless of server timezone and makes the
// composite-PK upsert hit the same row on a same-day re-run.
function todayUtcDate(): Date {
  const ymd = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' in UTC
  return new Date(`${ymd}T00:00:00.000Z`);
}

export async function runSnapshotJob(
  derive: typeof computeDerived = computeDerived,
): Promise<SnapshotJobResult> {
  const snapshotDate = todayUtcDate();
  let snapshotted = 0;
  let failed = 0;

  // All portfolios (id + owner), via the portfolios service so the snapshot job
  // doesn't reach into the Portfolio table directly (module isolation —
  // architecture line 1262-1263, retrofit-3 §1.6). The Pro filter is applied
  // per-portfolio via getEffectivePlan (cancelled-in-period still counts as Pro),
  // memoized per user so a multi-portfolio Pro user costs a single subscription read.
  const portfolios = await listAllPortfolioIdsForJobs();

  const planByUser = new Map<number, 'free' | 'pro'>();
  const effectivePlan = async (userId: number): Promise<'free' | 'pro'> => {
    const cached = planByUser.get(userId);
    if (cached) return cached;
    const plan = await getEffectivePlan(userId);
    planByUser.set(userId, plan);
    return plan;
  };

  // Every portfolio the loop actually reaches (success OR caught failure). Drives
  // missed-snapshot detection below: a "miss" is a Pro portfolio the loop never
  // processed at all — distinct from a FAILURE (reached-but-threw, counted under
  // `failed`). retrofit-3 §1.7 reconciled with the test-324 intent that failed ≠
  // missed: counting a caught failure as also-missed would double-count and muddy
  // the alert. Under normal completion every portfolio is reached, so `missed` is 0;
  // it only fires if the loop exits abnormally before reaching some Pro portfolios.
  const processedIds = new Set<number>();

  for (const portfolio of portfolios) {
    processedIds.add(portfolio.id);
    try {
      if ((await effectivePlan(portfolio.userId)) !== 'pro') continue; // free → no snapshot
      const derived = await derive(portfolio.id);
      await prisma.balanceSnapshot.upsert({
        where: {
          portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate },
        },
        create: {
          portfolioId: portfolio.id,
          userId: portfolio.userId,
          snapshotDate,
          value: derived.totalValue,
        },
        update: { value: derived.totalValue },
      });
      snapshotted++;

      // PnL/analytics cache invalidation (retrofit-3 §1.8, architecture line 1228;
      // extended Stage 14 §1.9). Mirrors transactions.service.ts:invalidatePnlCache —
      // deletes the full portfolioDerivedCacheKeys set so a fresh snapshot also evicts
      // the stale analytics_* caches. A Redis failure logs and continues; it must
      // never roll back the snapshot write.
      const keys = portfolioDerivedCacheKeys(portfolio.id);
      await redis
        .del(...keys)
        .catch((e: Error) =>
          console.error(
            `[snapshots] cache invalidation failed for portfolio ${portfolio.id}:`,
            e.message,
          ),
        );
    } catch (err) {
      failed++;
      console.error(
        '[snapshots]',
        JSON.stringify({ event: 'snapshot_failed', portfolioId: portfolio.id }),
        err,
      );
    }
  }

  // Missed-snapshot detection (retrofit-3 §1.7, architecture line 1222 "flag and
  // alert on missed snapshots"). planByUser is already populated, so this is pure
  // Map lookups — no extra DB queries.
  let missed = 0;
  for (const portfolio of portfolios) {
    if (processedIds.has(portfolio.id)) continue;
    if ((await effectivePlan(portfolio.userId)) !== 'pro') continue;
    missed++;
    console.error(
      '[snapshots]',
      JSON.stringify({ event: 'missed_snapshot', portfolioId: portfolio.id, userId: portfolio.userId }),
    );
  }

  // Retention prune — once, after the loop. A failure here (e.g. hypertable
  // missing) must not abort the job nor block the next run; log and move on.
  let dropChunksSucceeded = false;
  try {
    await prisma.$queryRawUnsafe(RETENTION_SQL);
    dropChunksSucceeded = true;
  } catch (err) {
    console.error('[snapshots]', JSON.stringify({ event: 'drop_chunks_failed' }), err);
  }

  console.log(
    '[snapshots]',
    JSON.stringify({ event: 'job_complete', snapshotted, failed, missed, dropChunksSucceeded }),
  );
  return { snapshotted, failed, missed, dropChunksSucceeded };
}

export function startSnapshotScheduler(): void {
  if (!config.SNAPSHOT_ENABLED) {
    console.log('[snapshots] cron disabled by SNAPSHOT_ENABLED=false');
    return;
  }
  const expr = config.SNAPSHOT_CRON;
  cron.schedule(expr, async () => {
    try {
      await runSnapshotJob();
    } catch (e) {
      // Never crash the scheduler — log + continue
      console.error('[snapshots] uncaught job error:', e);
    }
  });
  console.log(`[snapshots] cron registered with schedule ${expr}`);
}
