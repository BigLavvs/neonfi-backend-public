# Neonfi backend — Retrofit 3: snapshots module + derive.ts cache + missed-snapshot flagging

This file is the source-of-truth intent for retrofit-3. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 8a0cdc9 (retrofit-2).

Background: the audit surfaced that Stage 13 shipped only the snapshot job — never the `snapshots/` module structure, the read endpoint, the PnL cache GET/SET in derive.ts, or the missed-snapshot flagging. The cache invalidation hooks went in via retrofit-2, but they invalidate a key nothing writes yet. Retrofit-3 closes those gaps and unblocks Stage 14.

What ships here:
- `src/modules/snapshots/` module (repository, service, dto, controller) — the structural home the architecture mandates (architecture.txt §Snapshot Module, line 1214; implementation.txt §4 module structure, line 109)
- `GET /portfolios/:portfolioId/snapshots` endpoint (architecture.txt line 608-611; missing from Stage 13)
- derive.ts gains Redis cache GET/SET on `portfolio_pnl:<portfolioId>` (5-min TTL per Build Guide §2.5; retrofit-2 already wired the invalidation hooks)
- derive.ts computes real `pnlAllTime` and `pnlAllTimeValue` now that Portfolio.netDeposit is maintained (retrofit-2). 24h/7d/30d stay zero — Stage 14 owns those (cross-module read of snapshots belongs in analytics module)
- snapshot.job.ts gets a missed-snapshot detection pass (architecture.txt line 102; implementation.txt line 687)
- snapshot.job.ts routes its Portfolio query through a portfolios service helper (module isolation per architecture.txt line 1262)
- snapshot.job.ts invalidates `portfolio_pnl:<id>` after each upsert (architecture.txt line 1228)

Out of scope: Stage 14 analytics endpoints (separate prompt). Stage 15 email retries (separate prompt).

## 0. Read first

This retrofit touches `src/modules/portfolios/derive.ts`, the snapshot job, and creates a new module. Read each file before editing — the recent track record of doing this has caught real divergences early.

1. `prisma/schema.prisma` — the `BalanceSnapshot` model (lines 407-436). Verify column types and the composite PK shape one more time. The DTO must match what this model produces.
2. `src/modules/portfolios/derive.ts` (full — 47 lines) — current shape after retrofit-2. The function still returns 0 for every PnL field. You'll wire the cache here AND compute `pnlAllTime`/`pnlAllTimeValue` from `Portfolio.netDeposit`.
3. `src/jobs/snapshot.job.ts` (full — 137 lines) — current state after Stage 13. You'll add module-isolation routing, cache invalidation, and missed-snapshot detection.
4. `src/modules/nfts/nfts.controller.ts` (full — 67 lines) — the canonical nested router pattern with `requireAuth` + `requirePlan(['pro'])` + portfolio-ownership middleware. The snapshots controller mirrors this shape exactly.
5. `src/modules/nfts/nfts.service.ts` and `src/modules/nfts/nfts.repository.ts` and `src/modules/nfts/nfts.dto.ts` (each is short) — module structure template for the new snapshots/ module.
6. `src/modules/portfolios/portfolios.service.ts` (full — 190 lines after retrofit-2) — you'll add a small helper for the snapshot job to use.
7. `src/app.ts` — current router mounts (line 41-56). You'll add the snapshots nested router.
8. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — §Stage 13 reference for the missing pieces, §2.4 pagination convention, §2.5 caching convention (5-min PnL TTL).
9. `Neonfi System Architecture.docx` (via the text export) — BalanceSnapshot resource rep (line 605-622) and Snapshot Module rules (line 1214-1232).
10. `src/modules/transactions/transactions.service.ts` (after retrofit-2; lines 30-45 for the `invalidatePnlCache` pattern) — mirror the same cache-invalidation idiom in the snapshot job.

## 1. Architecture decisions

### 1.1 New `snapshots/` module — 4 files [LOCKED]

```
src/modules/snapshots/
  snapshots.repository.ts
  snapshots.service.ts
  snapshots.dto.ts
  snapshots.controller.ts
```

The Snapshot module owns BalanceSnapshot. Architecture line 1230: "Entities owned: BalanceSnapshot." This module structure brings the codebase in line with implementation.txt §4 (line 109).

### 1.2 `GET /portfolios/:portfolioId/snapshots` — paginated list [LOCKED]

The architecture's snapshot URL list (line 608-611) is one endpoint. It's Pro-only, scoped to the owning user's portfolio (privacy via portfolio-ownership middleware), offset-paginated per Build Guide §2.4.

Endpoint contract:
- Path: `GET /api/v1/portfolios/:portfolioId/snapshots` (nested router under portfolios)
- Middleware chain: `requireAuth` → `requirePlan(['pro'])` → portfolio-ownership (loads Portfolio into context)
- Query: `?limit=<int>&offset=<int>`
- Defaults: `limit=365` (one year of dailies is a reasonable default for the performance page), `offset=0`
- Max limit: `730` (matches `SNAPSHOT_RETENTION_DAYS`). Larger → `400 VALIDATION_ERROR`.
- Order: `snapshotDate DESC` (newest first; matches the typical chart-rendering pattern that gets the latest date and reverses for display)
- Response envelope: `{ data: { snapshots: [SnapshotDTO, ...] }, meta: { limit, offset, total } }`

Manual portfolios: return `200 { data: { snapshots: [] } }` rather than 4xx. Same UX-friendly approach as Stage 12 NFTs on manual portfolios. No snapshots will exist for manual portfolios (snapshot job only iterates Pro users, but it doesn't filter by portfolio type — so manual Pro portfolios DO get snapshots). Re-reading Stage 13's snapshot.job.ts:65 — the iteration is across ALL portfolios, then plan-gated per user. So manual Pro portfolios get snapshotted alongside connected Pro portfolios. The list endpoint returns whatever exists. The "manual = empty" behavior of NFTs doesn't apply here.

### 1.3 SnapshotDTO shape — match architecture verbatim [LOCKED]

Architecture resource rep (architecture.txt line 615-622):
```
{
  "id": "123",
  "portfolioId": "123 FK",
  "userId": "123 FK",
  "value": 10133.37,
  "snapshotDate": "2026-04-09",
  "createdAt": "timestamp"
}
```

DTO interface (mirror exactly — fields and types):
```ts
export interface SnapshotDTO {
  id: number;
  portfolioId: number;
  userId: number;
  value: number;          // serialized as Number — architecture shows numeric, not string
  snapshotDate: string;   // serialized as YYYY-MM-DD (date column, no time component)
  createdAt: Date;        // serialized by Hono as ISO timestamp string in the response
}
```

`value` deserialization: `Number(snapshot.value.toString())` — the Decimal needs to round-trip through string to avoid floating point drift.

`snapshotDate` serialization: the column is `@db.Date`, so Prisma returns a `Date` object at UTC midnight. The architecture rep shows `"2026-04-09"` — strip the time component. `snapshot.snapshotDate.toISOString().slice(0, 10)` returns `YYYY-MM-DD` reliably.

### 1.4 Snapshot module reads ONLY snapshots; no cross-module queries [LOCKED]

Architecture line 1262-1263: "no direct cross-table queries between modules; inter-module communication occurs only via exposed application services." The snapshots module owns BalanceSnapshot and reads it. The portfolio ownership check happens in the controller middleware via `findPortfolioById` (from portfolios.repository) — that's the established pattern (nfts.controller.ts:28-29 does the same). Accepted boundary crossing for ownership middleware.

### 1.5 derive.ts gains Redis cache GET/SET [LOCKED]

The cache key, TTL, and invalidation rules are all set:
- Key: `portfolio_pnl:<portfolioId>` (already documented in derive.ts:4)
- TTL: 300 seconds (5 min, Build Guide §2.5)
- Invalidation: on snapshot write (this retrofit, §1.7) + on transaction CUD (already wired in retrofit-2, transactions.service.ts:30-45)

New derive.ts shape:

```ts
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

const CACHE_TTL_S = 300;

export interface DerivedFields {
  totalValue: number;
  pnlAllTime: number;
  pnlAllTimeValue: number;
  pnl24h: number;
  pnl24hValue: number;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
}

export async function computeDerived(portfolioId: number): Promise<DerivedFields> {
  // 1. Cache check
  const cached = await redis.get(`portfolio_pnl:${portfolioId}`).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DerivedFields;
      // Defensive: validate the parsed shape has the expected keys before returning
      if (typeof parsed.totalValue === 'number' && typeof parsed.pnlAllTime === 'number') {
        return parsed;
      }
    } catch {
      // Fall through to recompute
    }
  }

  // 2. Compute from DB
  const result = await computeFromDb(portfolioId);

  // 3. Write back to cache. Never let a Redis failure roll back the read.
  await redis
    .set(`portfolio_pnl:${portfolioId}`, JSON.stringify(result), 'EX', CACHE_TTL_S)
    .catch((e: Error) =>
      console.error(`[derive] cache set failed for portfolio ${portfolioId}:`, e.message),
    );

  return result;
}

async function computeFromDb(portfolioId: number): Promise<DerivedFields> {
  const [assets, portfolio] = await Promise.all([
    prisma.asset.findMany({
      where: { portfolioId },
      include: { token: true },
    }),
    prisma.portfolio.findUnique({
      where: { id: portfolioId },
      select: { netDeposit: true },
    }),
  ]);

  let totalValue = 0;
  for (const a of assets) {
    const balance = Number(a.balance.toString());
    const price = Number(a.token.currentPrice.toString());
    totalValue += balance * price;
  }

  // All-time PnL (retrofit-3 §1.6): now that Portfolio.netDeposit is maintained
  // (retrofit-2), pnlAllTime = totalValue − netDeposit. Percentage is a relative
  // change vs cost basis; guard against divide-by-zero for portfolios with no
  // deposits (returns 0 rather than NaN/Infinity).
  const netDeposit = portfolio ? Number(portfolio.netDeposit.toString()) : 0;
  const pnlAllTimeValue = totalValue - netDeposit;
  const pnlAllTime = netDeposit !== 0 ? (pnlAllTimeValue / netDeposit) * 100 : 0;

  return {
    totalValue,
    pnlAllTime,
    pnlAllTimeValue,
    // 24h/7d/30d PnL needs historical snapshot data — owned by Stage 14
    // analytics module (architecture line 1194-1212). Cross-module read of
    // BalanceSnapshot belongs there, not here. Leave at 0 for now.
    pnl24h: 0,
    pnl24hValue: 0,
    pnl7d: 0,
    pnl7dValue: 0,
    pnl30d: 0,
    pnl30dValue: 0,
  };
}
```

Update the top-comment to reflect the new state — the existing TODO about "PnL stays 0 until Stage 13" is now stale; replace it with a brief note about what derive.ts owns vs what Stage 14 will own.

### 1.6 Module isolation fix — snapshot.job calls portfolios service [LOCKED]

Current `src/jobs/snapshot.job.ts:65-67`:
```ts
const portfolios = await prisma.portfolio.findMany({
  select: { id: true, userId: true },
});
```

Snapshot module reaching into Portfolio's table directly. Architecture line 1262: "no direct cross-table queries between modules."

Fix: add a small helper to `portfolios.service.ts`:

```ts
/**
 * Returns the minimal {id, userId} pair for every portfolio in the system.
 * Used ONLY by the daily snapshot job (src/jobs/snapshot.job.ts). The job
 * filters Pro plans per-user via getEffectivePlan, so this returns everything
 * and lets the caller decide. Exposed as a service so the snapshot module
 * doesn't query the Portfolio table directly (module isolation rule —
 * architecture line 1262-1263).
 */
export async function listAllPortfolioIdsForJobs(): Promise<Array<{ id: number; userId: number }>> {
  return prisma.portfolio.findMany({ select: { id: true, userId: true } });
}
```

Update snapshot.job.ts to import and use it.

### 1.7 snapshot.job missed-snapshot detection [LOCKED]

After the per-portfolio loop completes, check which Pro portfolios didn't get a snapshot today. Architecture line 1222: "Flag and alert on missed snapshots." Build Guide §Stage 13 same requirement.

Implementation: track the IDs that got successfully snapshotted in a Set during the loop. After the loop, iterate the candidate list again — any Pro user's portfolio NOT in the success set is a miss. Log each.

Add to the return type: `missed: number`. Update the existing log line to include it.

```ts
// In runSnapshotJob, before the for-loop:
const snapshottedIds = new Set<number>();

// Inside the try block, after the upsert succeeds:
snapshottedIds.add(portfolio.id);

// After the loop (before drop_chunks):
let missed = 0;
for (const portfolio of portfolios) {
  if (snapshottedIds.has(portfolio.id)) continue;
  // Skip portfolios whose owner is not Pro — they're expected to be unsnapshotted.
  if ((await effectivePlan(portfolio.userId)) !== 'pro') continue;
  // Pro portfolio that didn't get snapshotted — flag it.
  missed++;
  console.error('[snapshots]', JSON.stringify({
    event: 'missed_snapshot',
    portfolioId: portfolio.id,
    userId: portfolio.userId,
  }));
}

// Update the final log line:
console.log('[snapshots]', JSON.stringify({
  event: 'job_complete',
  snapshotted,
  failed,
  missed,           // NEW
  dropChunksSucceeded,
}));

// Extend SnapshotJobResult interface with `missed: number`.
return { snapshotted, failed, missed, dropChunksSucceeded };
```

The missed-check loop reuses `effectivePlan` from the outer scope. `planByUser` is already populated from the first pass, so the second pass is just Map lookups — no extra DB queries.

### 1.8 snapshot.job invalidates PnL cache after each upsert [LOCKED]

Mirrors retrofit-2's pattern. Architecture line 1228: "Each snapshot triggers Redis PnL cache invalidation for the affected portfolio."

After each successful `prisma.balanceSnapshot.upsert`:

```ts
await redis
  .del(`portfolio_pnl:${portfolio.id}`)
  .catch((e: Error) =>
    console.error(`[snapshots] cache invalidation failed for portfolio ${portfolio.id}:`, e.message),
  );
```

Place this INSIDE the try block right after `snapshotted++`. If the redis.del fails, log and continue — never roll back the snapshot write.

Import `redis` at the top of snapshot.job.ts.

### 1.9 derive.ts cache is process-safe but not race-proof [LOCKED, documented]

Two concurrent requests for the same portfolio's PnL could each MISS the cache, both compute, both write. The second write wins. That's fine — the values are deterministic for the same Asset state. No need for a distributed lock at MVP scale. Document this in a code comment alongside the cache set so the next reader understands the choice.

## 2. Module scope

```
src/modules/snapshots/snapshots.repository.ts             # NEW
src/modules/snapshots/snapshots.service.ts                # NEW
src/modules/snapshots/snapshots.dto.ts                    # NEW
src/modules/snapshots/snapshots.controller.ts             # NEW — nested router
src/app.ts                                                # EDIT — mount nested router
src/modules/portfolios/derive.ts                          # EDIT — cache wiring + real pnlAllTime
src/modules/portfolios/portfolios.service.ts              # EDIT — add listAllPortfolioIdsForJobs
src/jobs/snapshot.job.ts                                  # EDIT — module isolation, missed detection, cache invalidation
tests/snapshots-api.test.ts                               # NEW — endpoint tests
tests/snapshots.test.ts                                   # EDIT — extend Stage 13's job tests with retrofit-3 behaviors
```

No schema delta. No migration. No new env vars.

## 3. Tests

Test numbering continues from 312. Aim for ~10 new tests across both files.

### `tests/snapshots-api.test.ts` (NEW)

313. **GET /snapshots happy path: Pro user with 5 seeded snapshot rows → 200, data.snapshots length=5, ordered snapshotDate DESC.** Seed 5 snapshots directly via `prisma.balanceSnapshot.create` with descending dates.
314. **GET /snapshots paginated: 10 rows, ?limit=3&offset=2 → 200, data.snapshots length=3, meta.{limit:3, offset:2, total:10}, the 3rd-5th rows by date DESC.**
315. **GET /snapshots ?limit=800 → 400 VALIDATION_ERROR** (max is 730).
316. **GET /snapshots as Free user → 403 PLAN_LIMIT_REACHED** (requirePlan gate).
317. **GET /snapshots on another user's portfolio → 403 FORBIDDEN** (portfolio-ownership middleware).
318. **GET /snapshots on portfolio with no rows → 200, data.snapshots: [], meta.total: 0.**
319. **GET /snapshots no auth → 401.**
320. **Response shape: each row has `id, portfolioId, userId, value (number), snapshotDate (YYYY-MM-DD string), createdAt (ISO string)`.** Assert the keys and types of one row.

### `tests/snapshots.test.ts` (EDIT — extend Stage 13's existing tests)

321. **derive.ts cache HIT: pre-populate `portfolio_pnl:<id>` with a known JSON payload, call `computeDerived(id)`, assert the returned object equals the cached payload (no DB recompute).** Verify by inspecting an unrelated field that ONLY the cached version has (e.g. inject `totalValue: 9999.99` and assert it comes back).
322. **derive.ts cache MISS: clear `portfolio_pnl:<id>`, call `computeDerived(id)`, assert the cache key now exists with the computed JSON.**
323. **derive.ts pnlAllTime computation: portfolio with netDeposit=10000 and current totalValue=12500 → pnlAllTimeValue=2500, pnlAllTime=25.** Seed an Asset with balance×currentPrice that produces totalValue=12500 and a Portfolio with netDeposit=10000.
324. **snapshot.job missed-snapshot detection: seed 2 Pro portfolios, force one to throw during derive (mock or use a portfolio with an unresolvable asset). Result: snapshotted=1, failed=1, missed=0** — because the failed one is detected via the failed counter, not the missed counter. To trigger missed=1, you'd need a Pro portfolio that the loop never reaches; that's only possible if the loop crashes mid-iteration. For MVP, document this nuance in a comment and have the test confirm `missed` is defined and zero in the happy path. (Adjusting test scope: assert `missed: 0` in a happy-path 2-Pro-portfolio run; assert that the new `missed` field is present in `SnapshotJobResult` and the log line.)
325. **snapshot.job PnL cache invalidation: spy on `redis.del`. Run `runSnapshotJob()` against 2 Pro portfolios. Assert `redis.del` called with `portfolio_pnl:<id>` for each.**
326. **snapshot.job module isolation: `runSnapshotJob` calls `listAllPortfolioIdsForJobs` (mock the export, assert it was called once).** This verifies the indirection layer is real. Alternative: trust the type-checker + manual code review. I'll go with the lighter touch — skip an explicit test for this and rely on the import path. (Drop test 326 from the planned list.)

Adjusted total: 13 new tests (313-325). Final test count target: 325.

### What to do about Stage 13's existing tests in snapshots.test.ts

Don't delete them — extend them. Two existing tests likely break or need updates:
- Any test that asserts the `SnapshotJobResult` shape exhaustively will fail because `missed` is now a property. Update the assertion.
- Any test that asserts no Redis cache interaction during the job will fail because of the new `redis.del`. Update by allowing the new key.

If anything else breaks, surface it — don't paper over.

## 4. STOP-AND-ASK gates

1. **If `computeFromDb` becomes too slow** (because the Asset+Token+Portfolio queries are now done on every cache miss instead of the prior single-query path), profile. Two queries via `Promise.all` should be fast. If it's not, surface — there may be a missing index.
2. **If the SnapshotDTO `value` serialization produces precision loss** (Decimal → number via Number(string) → JSON), check the values in tests. Architecture shows numeric values; if Idowu wants string for full precision, we can flip. Default is number per the architecture rep.
3. **If `snapshotDate.toISOString().slice(0, 10)` returns the wrong day** (timezone edge case — the Prisma Decimal column behaves at UTC midnight, so this should be exact, but if the test machine somehow translates to local time, the assertion will fail). The fix is `Date.UTC` arithmetic, not local-time formatting.
4. **If a test for cache hit returns DB-fresh data instead of cached data**, the cache GET didn't fire. Investigate the JSON parse path — a malformed value would silently fall through to recompute, defeating the test.
5. **If `listAllPortfolioIdsForJobs` ends up needed by some other module (analytics, etc.)** — it shouldn't. The name flags it as job-only. If something else wants it, that's a sign of a different cross-module need.

## 5. What NOT to do

- **No Stage 14 analytics endpoints.** That's its own prompt next.
- **No edits to transactions.service.ts.** The invalidation hooks from retrofit-2 already do their job; derive.ts now reads what they invalidate.
- **No schema changes.** Everything needed is already in the model after retrofit-2.
- **No new env vars.**
- **No backfilling derived values for old snapshots.** BalanceSnapshot rows store `value` only; derive.ts is for the current-state derived fields. They live in different stores.
- **No editing the architecture or schema docx.** Doc-fix items go in the commit report.
- **No `npm audit fix`.**
- **No bundling stage-14.md.** Same scope-leak discipline as retrofit-1 and retrofit-2.

## 6. Commit and report

Stage explicitly:

```bash
git add prisma/schema.prisma \
        src/modules/snapshots/snapshots.repository.ts \
        src/modules/snapshots/snapshots.service.ts \
        src/modules/snapshots/snapshots.dto.ts \
        src/modules/snapshots/snapshots.controller.ts \
        src/app.ts \
        src/modules/portfolios/derive.ts \
        src/modules/portfolios/portfolios.service.ts \
        src/jobs/snapshot.job.ts \
        tests/snapshots-api.test.ts \
        tests/snapshots.test.ts \
        _claude/retrofit-3.md
git commit -m "feat(snapshots): retrofit-3 — snapshots module + GET /portfolios/:id/snapshots + derive.ts PnL cache + missed-snapshot flagging"
git log --oneline -5
```

(`prisma/schema.prisma` is in the stage list defensively — if it's not modified, `git add` is a no-op for it.)

Report:
- New commit SHA.
- One curl per new endpoint surface:
  - `GET /api/v1/portfolios/<id>/snapshots` as Pro user, happy path → show the JSON
  - Same as Free user → 403 PLAN_LIMIT_REACHED
  - Same with `?limit=800` → 400 VALIDATION_ERROR
- Confirmation derive.ts now reads/writes `portfolio_pnl:<id>`. Show one redis.get of that key after a single `computeDerived` call returning a non-empty JSON.
- Confirmation `pnlAllTime` is non-zero for a Pro portfolio with netDeposit ≠ totalValue.
- Confirmation `runSnapshotJob()` returns `{ snapshotted, failed, missed, dropChunksSucceeded }` and the `[snapshots] job_complete` log line includes the `missed` count.
- Vitest output: all tests passing (count expected ~325: 312 baseline + 13 new).
- Doc-fix pile items added in retrofit-3:
  - `Neonfi System Architecture.docx` (optional): note that the snapshots module is now real; the resource rep matches what's documented.
  - `Neonfi System Implementation.docx` (optional): page-definitions reference to `GET /portfolios/{id}/snapshots` matches the implemented endpoint.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
