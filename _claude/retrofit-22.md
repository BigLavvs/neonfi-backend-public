# retrofit-22: gate the drop_chunks assertion on TimescaleDB presence (local-test support)

Tests can now run against a **local vanilla Postgres** (`DATABASE_URL_TEST`) for speed + isolation
from Neon. One test breaks there: snapshots test **300** asserts `dropChunksSucceeded === true`,
but `drop_chunks` is a **TimescaleDB** function that doesn't exist on vanilla Postgres — so #300
fails locally (only). Neon has TimescaleDB, so it must still run there. Gate it on TimescaleDB
presence: skip when absent, run when present. Do NOT weaken the assertion.

Read `tests/snapshots.test.ts` first (esp. test 300 + the existing setup/imports).

## Change (tests/snapshots.test.ts)
1. Add a one-time TimescaleDB probe (module scope + populated in the existing `beforeAll`, or a
   `beforeAll` if none): query whether the extension is installed —
   ```ts
   let hasTimescale = false;
   beforeAll(async () => {
     const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
       SELECT count(*)::bigint AS n FROM pg_extension WHERE extname = 'timescaledb'`;
     hasTimescale = Number(rows[0]?.n ?? 0) > 0;
   });
   ```
   (Keep any existing beforeAll body; just add this probe.)
2. In test **300**, skip at runtime when TimescaleDB is absent, using the Vitest test context —
   so it still runs on Neon but is cleanly SKIPPED (not failed, not silently passed) on local PG:
   ```ts
   it('300: drop_chunks runs after snapshotting — …', async (ctx) => {
     if (!hasTimescale) ctx.skip(); // local vanilla Postgres has no drop_chunks; runs on Neon
     // …unchanged assertions…
   });
   ```
   (Vitest 2.x supports `ctx.skip()`. If a non-context form is cleaner in this file, an equivalent
   guard is fine — the requirement is SKIP-when-absent, never weaken the `=== true` assertion.)
3. Leave every other snapshot test unchanged — they only TRUNCATE/insert `balance_snapshot`
   (works as a plain table) and don't depend on `drop_chunks`.

## Gates
- Local (vanilla PG, `DATABASE_URL_TEST` set): `npx vitest run tests/snapshots.test.ts` → all pass,
  with **300 reported as skipped**.
- (If you can run against Neon) 300 executes and passes as before.

## Commit (explicit add, no -A)
```bash
git add tests/snapshots.test.ts _claude/retrofit-22.md
git commit -m "test(snapshots): skip drop_chunks assertion (300) when TimescaleDB absent — local vanilla-PG test DB support (retrofit-22)"
```
Report SHA + confirm 300 skips locally / runs on TimescaleDB.
