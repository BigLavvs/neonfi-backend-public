# Neonfi backend — Stage 13: Daily snapshot job + drop_chunks retention

This file is the source-of-truth intent for Stage 13. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 9f2a518 (Stage 12).

Stage 13 is the smallest stage in a while. Two things only:
1. Daily node-cron job that snapshots every Pro-portfolio's `totalValue` into `balance_snapshot`.
2. drop_chunks call that deletes balance_snapshot chunks older than `SNAPSHOT_RETENTION_DAYS` (= 730, already in `src/lib/constants.ts` from Stage 12).

No new endpoints. Stage 14 (Analytics) owns the read API that consumes these snapshots.

## 0. Read first

1. `_claude/stage-9b.md` (token-sync cron pattern — Stage 13's job follows the same scaffolding), `_claude/stage-12.md` §6.4 (where `SNAPSHOT_RETENTION_DAYS` was defined).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 13 in §3**, **§Functional Requirements** (Pro-only snapshots, daily cadence), **§System Implementation** snapshot section.
3. `Neonfi System Architecture.docx` — **BalanceSnapshot entity** (resource rep, write rules), **Snapshot module** rules. Pay attention to whether the architecture spec requires more than just totalValue per snapshot (might also want costBasis or pnl per the resource rep).
4. `prisma/schema.prisma` — `BalanceSnapshot` model. Stage 1A locked composite PK `@@id([portfolioId, snapshotDate])` with `id` retained as non-PK autoincrement (TimescaleDB hypertable requirement). Verify what columns exist beyond `id`, `portfolioId`, `snapshotDate`. If the model has `totalValue` only, fine — the snapshot job writes that one column. If it also has `costBasis`, `unrealizedPnl`, etc., the job populates all of them via `derive.ts` outputs.
5. `src/modules/portfolios/derive.ts` — Stage 7/8's `computeDerived(portfolio)` helper. Stage 13's snapshot job calls this per portfolio.
6. The TimescaleDB hypertable: it was registered on `balance_snapshot.snapshotDate` in Stage 1A's setup. Confirm via `SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'balance_snapshot';` if uncertain. If for any reason the hypertable wasn't created (e.g., the SQL was deferred to Stage 13), STOP gate 1.
7. The existing cron-scheduler entry point — token-sync was the first cron job (Stage 9B). Its registration lives somewhere like `src/jobs/scheduler.ts` or inline in `src/app.ts`. Find it; extend the same registry rather than creating a parallel scheduler.

## 1. Architecture decisions

### 1.1 Cron schedule [LOCKED]

Default: `0 0 * * *` (midnight UTC, every day). Override via env var `SNAPSHOT_CRON`.

Why midnight UTC: the architecture rep stores `snapshotDate` as a `date` (not timestamptz). Midnight UTC means each row's `snapshotDate` is unambiguously "today" without timezone arithmetic. Frontend renders the date as-is.

If the architecture docx says a different cadence (e.g., "every hour"), STOP gate 2 and surface — daily is what Build Guide §Stage 13 says but architecture wins.

### 1.2 Pro-only [LOCKED]

For each portfolio, call `getEffectivePlan(userId)`. Skip non-Pro users entirely. Architecture-aligned: free users get no historical chart, so no snapshots.

If a user upgrades mid-day, their first snapshot is the next day's run. If a user downgrades mid-day, their previous snapshots remain (we don't delete history on downgrade — that's a separate retention policy and architectural fight we'll have if/when it comes up). Build Guide says: "Downgrade preserves historical data; the chart just isn't shown in the free UI." Lock that here.

### 1.3 Idempotency via composite PK + upsert [LOCKED]

The PK is `(portfolioId, snapshotDate)`. If the job runs twice on the same day (e.g., a manual `runSnapshotJob()` trigger after the cron already fired), the second run upserts on the existing row. Use `prisma.balanceSnapshot.upsert` keyed on the composite, with `update: { totalValue, ... }` — re-snapshots are an explicit rewrite, not a no-op. The use case: someone notices the morning snapshot reflected a momentarily wrong price (Coinbase WS reconnect mid-snapshot), they fix the issue, and they want to re-trigger to overwrite. Allowing upsert makes that possible. Don't think of this as "idempotency" — it's "today's snapshot can be rewritten by re-running the job." Subtle but important.

### 1.4 drop_chunks runs once per day, after snapshotting [LOCKED]

In the same job function, after the per-portfolio snapshot loop completes, call:

```sql
SELECT drop_chunks('balance_snapshot', NOW() - INTERVAL '730 days');
```

The 730 is `SNAPSHOT_RETENTION_DAYS` from `src/lib/constants.ts`. Build the SQL string from the constant. drop_chunks is idempotent and fast (no-op if there are no chunks past the cutoff).

If the hypertable doesn't exist (§0 finding), drop_chunks throws. The job should catch and log gracefully — don't let drop_chunks failure prevent the snapshot loop from being marked successful next time.

### 1.5 Per-portfolio snapshot failures must not abort the whole job [LOCKED]

If one portfolio's `computeDerived()` throws (e.g., a Token row is missing for an asset), log the error with `portfolioId` and continue to the next portfolio. Don't let one bad portfolio block all the others. Aggregate counts at the end: `{ portfolios_snapshotted, portfolios_failed, drop_chunks_succeeded }` for the structured log line.

### 1.6 SNAPSHOT_ENABLED env var [LOCKED]

Boolean env var, default `true`. Mirrors `TOKEN_SYNC_ENABLED` from Stage 9B. Lets dev environments boot without scheduling the snapshot job. Read from `config.SNAPSHOT_ENABLED`; if false, the scheduler registration is skipped at boot. Tests will set it to `false` (job is invoked manually in tests via `runSnapshotJob()`, not via cron).

## 2. Module scope

```
src/jobs/snapshots.ts             # NEW — runSnapshotJob() entry point + helpers
src/jobs/scheduler.ts             # EDIT — register the cron alongside token-sync (or wherever token-sync lives)
src/lib/config.ts                 # EDIT — add SNAPSHOT_ENABLED + SNAPSHOT_CRON
tests/snapshots.test.ts           # NEW — ~6 tests
```

The `src/jobs/snapshots.ts` file exports:
- `runSnapshotJob(): Promise<{ snapshotted: number; failed: number; dropChunksSucceeded: boolean }>` — the unit-testable entrypoint
- A separate `registerSnapshotCron()` function called from `scheduler.ts` if `SNAPSHOT_ENABLED === true`

If Stage 9B's scheduler.ts has a different shape (e.g., uses a registry array), follow that pattern. Consistency over my prescription.

## 3. Job logic in pseudocode

```
runSnapshotJob():
  snapshotDate = today_utc_date_string()  // YYYY-MM-DD
  snapshotted = 0
  failed = 0

  // Find all portfolios whose owner is currently Pro
  portfolios = await prisma.portfolio.findMany({
    where: { user: { subscription: { plan: { name: 'pro' } } } },
    include: { user: true, assets: { include: { token: true } }, type: true },
  })

  for portfolio of portfolios:
    try:
      derived = await computeDerived(portfolio)
      await prisma.balanceSnapshot.upsert({
        where: { portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate } },
        create: { portfolioId, snapshotDate, totalValue: derived.totalValue, /* + any other fields from rep */ },
        update: { totalValue: derived.totalValue, /* + others */ },
      })
      snapshotted++
    catch err:
      console.error('[snapshots]', JSON.stringify({ event: 'snapshot_failed', portfolioId: portfolio.id }), err)
      failed++

  // Retention
  let dropChunksSucceeded = false
  try:
    await prisma.$executeRaw`SELECT drop_chunks('balance_snapshot', NOW() - INTERVAL '${SNAPSHOT_RETENTION_DAYS} days')`
    dropChunksSucceeded = true
  catch err:
    console.error('[snapshots]', JSON.stringify({ event: 'drop_chunks_failed' }), err)

  console.log('[snapshots]', JSON.stringify({ event: 'job_complete', snapshotted, failed, dropChunksSucceeded }))
  return { snapshotted, failed, dropChunksSucceeded }
```

Two subtleties:
- `today_utc_date_string()` must be deterministic and timezone-safe. Use `new Date().toISOString().split('T')[0]` — that's YYYY-MM-DD in UTC regardless of server timezone.
- The Prisma `$executeRaw` with a tagged template literal can't interpolate the 730 as a parameter (PostgreSQL syntax restriction on INTERVAL). Build it as a raw SQL string and use `$executeRawUnsafe(`SELECT drop_chunks('balance_snapshot', NOW() - INTERVAL '${days} days')`)`. This is safe because `days` comes from a typed constant, not user input. If you're uneasy, hardcode `'730 days'` directly in the SQL.

## 4. Resource rep alignment — possible BalanceSnapshot columns beyond totalValue

The architecture spec might require `costBasis` and `unrealizedPnl` on each snapshot (so Stage 14's analytics can chart PnL history without recomputing from transactions each day). Check `derive.ts` to see what it produces.

If `derive.ts` produces `costBasis` and `unrealizedPnl`, and BalanceSnapshot has those columns: write them.

If `derive.ts` produces them but BalanceSnapshot doesn't have the columns: **schema delta** — add them as nullable strings. Same pattern as Stage 12's NFT marketplace fields. Add to doc-fix pile.

If `derive.ts` doesn't produce them: Stage 13 only writes totalValue. Stage 14 will need to either extend `derive.ts` or accept that PnL charts read from current state only (not historical). Surface as STOP gate 3 if ambiguous.

My best guess given the established conventions: `derive.ts` currently produces `{ totalValue }` only, and BalanceSnapshot has `totalValue` only. Stage 13 writes that single column. PnL-over-time chart in Stage 14 will require a future extension.

## 5. Cross-cutting wiring

### 5.1 Config additions

In `src/lib/config.ts`:
```ts
SNAPSHOT_ENABLED: z.string().transform(v => v === 'true').default('true'),
SNAPSHOT_CRON: z.string().default('0 0 * * *'),
```

In `.env`: add `SNAPSHOT_ENABLED=true` and `SNAPSHOT_CRON=0 0 * * *` for documentation completeness. (In tests, override `SNAPSHOT_ENABLED=false` in `.env.test` if you have one, OR skip — the test file calls `runSnapshotJob()` directly without involving cron.)

### 5.2 Scheduler registration

In `src/jobs/scheduler.ts` (or wherever Stage 9B's `registerTokenSyncCron()` lives):
```ts
import cron from 'node-cron'
import { runSnapshotJob } from './snapshots.js'
import { config } from '../lib/config.js'

export function registerSnapshotCron() {
  if (!config.SNAPSHOT_ENABLED) {
    console.log('[snapshots] cron disabled by SNAPSHOT_ENABLED=false')
    return
  }
  cron.schedule(config.SNAPSHOT_CRON, async () => {
    try {
      await runSnapshotJob()
    } catch (e) {
      console.error('[snapshots] uncaught job error', e)
    }
  })
  console.log('[snapshots] cron registered with schedule', config.SNAPSHOT_CRON)
}
```

Wire `registerSnapshotCron()` into wherever `registerTokenSyncCron()` is called at boot.

## 6. Tests (Vitest, integration — new file `tests/snapshots.test.ts`)

Tests numbered 296–301. ~6 tests.

296. **Pro user with one portfolio (assets seeded) → runSnapshotJob() creates one row in balance_snapshot for today's UTC date with the expected totalValue.**

297. **Free user with a portfolio → runSnapshotJob() does NOT create a row for that portfolio.** Verify by user count: total `balance_snapshot` rows after the run = number of Pro portfolios, not all portfolios.

298. **Idempotency / upsert: run the job twice in the same UTC day → exactly one row for that portfolio (composite PK enforced).** Modify the totalValue between runs (e.g., add a new transaction) and verify the second row reflects the updated total.

299. **One portfolio throws during computeDerived (mock derive.ts to throw on a specific portfolioId) → the rest of the portfolios still get snapshotted.** Assert `failed: 1, snapshotted: N-1` in the return value.

300. **drop_chunks runs after the snapshot loop.** Hard to test without manipulating chunk boundaries directly. Practical alternative: assert `dropChunksSucceeded === true` in the return value, and that the SQL string contains `SNAPSHOT_RETENTION_DAYS` value. If drop_chunks throws because the chunk being targeted doesn't exist (no snapshots > 730 days old), the test should still pass — drop_chunks is idempotent.

301. **Multi-portfolio Pro user: 3 portfolios on one Pro user → 3 snapshot rows in one job run, all dated today UTC, each with correct totalValue.** Catches off-by-one bugs in the per-user-iterates-once kind of mistake.

If extra Stage 9B token-sync test patterns help (e.g., mocking the time/clock for deterministic snapshotDate), reuse them. Don't over-engineer the deterministic-clock setup — `new Date().toISOString().split('T')[0]` is stable within a single test run as long as the test doesn't cross UTC midnight.

Total tests after Stage 13: ~301.

## 7. STOP-AND-ASK gates

1. **TimescaleDB hypertable on balance_snapshot doesn't exist.** If `SELECT FROM timescaledb_information.hypertables` returns no row for `balance_snapshot`, the Stage 1A setup either didn't run that SQL or it failed silently. STOP. Surface the SQL needed to register the hypertable and ask whether to apply now.
2. **Architecture spec says cadence is not daily.** If the docx specifies hourly, weekly, or a per-plan-tier cadence (e.g., free=monthly), surface. Don't silently default to daily — architecture wins.
3. **derive.ts produces fields that the BalanceSnapshot schema can't store.** If `derive.ts` returns `{ totalValue, costBasis, unrealizedPnl }` but BalanceSnapshot only has `totalValue`, choose: (a) extend the schema (delta), (b) drop the extra fields and write only totalValue. Surface both options and recommend (a) since Stage 14 will need them anyway.
4. **drop_chunks SQL syntax error or permission denied.** Neon's TimescaleDB extension might require specific role grants. If the test query throws "permission denied" or "function does not exist", STOP — likely needs a manual GRANT or the extension installed differently than assumed.

## 8. What NOT to do

- **No new endpoints.** Stage 14 owns reads.
- **No backfilling historical snapshots.** Stage 13 writes today's snapshot. Past data is whatever was already there. Backfill is a separate operational tool.
- **No per-portfolio cron schedule.** One job for all Pro portfolios.
- **No deleting historical snapshots on plan downgrade.** Preserve all history.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 9. Commit and report

```bash
git add -A
git commit -m "feat(snapshots): Stage 13 — daily balance_snapshot job + drop_chunks 24-month retention"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation TimescaleDB hypertable status verified (exists or registered as part of this stage).
- Whether any schema delta was applied (BalanceSnapshot columns).
- One curl-less demonstration of `runSnapshotJob()` — manual invocation from a `tsx` script or REPL is fine, showing `{ snapshotted: N, failed: 0, dropChunksSucceeded: true }` against the dev DB.
- Vitest output: all ~301 tests passing.
- Confirmation the cron is registered at boot (look for `[snapshots] cron registered with schedule 0 0 * * *` log line on app start).
- Confirmation `SNAPSHOT_RETENTION_DAYS=730` is the value used in drop_chunks (grep proof in the built SQL or the source).
- Doc-fix pile items added in Stage 13:
  - Whatever schema delta was applied (if any).
  - Architecture Appendix item 8 already marked resolved in Stage 12 — no new docs entry needed.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
