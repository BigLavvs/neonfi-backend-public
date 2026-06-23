# Neonfi backend — Stage 14: Analytics endpoints + derive.ts extension

This file is the source-of-truth intent for Stage 14. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 5a8096d (Stage 13).

Stage 14 is the biggest remaining stage — it's the actual product feature users care about: the dashboard charts. After it lands, the frontend can render historical portfolio value, PnL over time, allocation pie charts, and performance summaries.

The stage has two big halves:

**Half A — extend the data we capture.** Stage 13's job currently writes only `BalanceSnapshot.value`. The architecture's snapshot rep wants more (`costBasis` and at least `unrealizedPnl`). Add schema columns, extend `derive.ts` to compute them, retrofit Stage 13's job to write them. Historical rows (already written daily for the past few days) get NULL for the new columns — backfilling is unrecoverable since we don't have historical prices. Going forward, every snapshot is complete.

**Half B — expose the analytics endpoints.** New `/snapshots` module with the read APIs the dashboard needs. ~4 endpoints, all Pro-gated, all under portfolio-ownership middleware. The exact endpoint list depends on what the architecture docx specifies and what the frontend actually consumes — Half B's first task is checking both.

Half A is the schema/job/derive change; Half B is the controller/service/DTO surface. Commit them together or split them — your call.

## 0. Read first

In this order:

1. `_claude/stage-13.md` (snapshot job, the `::date` drop_chunks gotcha, why BalanceSnapshot.value is the only column written today), `_claude/stage-8.md` (asset listing pattern; Stage 14's snapshot list endpoint mirrors it), `_claude/stage-12.md` (Pro-only + connected-only guard pattern from NFTs).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 14 in §3 in full**, **§Functional Requirements** analytics block (which chart series are required, which periods are supported), **§Plan-Based Access Control** (analytics is the second canonical Pro-gated read after NFTs).
3. `Neonfi System Architecture.docx` — **BalanceSnapshot entity resource rep** (the complete column list — this is the authoritative answer for which columns Half A adds), **Analytics endpoints list** (URLs + request/response shapes), **Snapshots Module** rules.
4. `prisma/schema.prisma` — current `BalanceSnapshot` model. Confirm what columns exist beyond `id`, `portfolioId`, `userId`, `snapshotDate`, `value`. The Stage 13 transcript notes ONLY `value` — verify; if the model already has the marketplace fields, Half A is mostly a no-op.
5. `src/modules/portfolios/derive.ts` — current `computeDerived(portfolioId: number)` shape. Stage 13's transcript notes it returns `totalValue` plus hardcoded-zero PnL fields. Half A makes those real.
6. `src/jobs/snapshot.job.ts` — Stage 13's job, where the upsert lives. Half A adds the new fields to `create:` and `update:`.
7. The frontend repo at `C:\Users\pelum\Desktop\Neonfi`. Critical for Half B:
   - `src/lib/components/dashboard/` (or wherever the chart components live) — which chart endpoints does the dashboard call? What query params? What response shape does each consumer expect?
   - `src/lib/api/` or `src/lib/services/` (or wherever the typed API client lives) — the fetch wrappers reveal the URL shape the backend is expected to expose.
   - The "1M / 3M / 6M / 1Y / ALL" period selector — those are the discrete `period` values the series endpoint needs to support.
   
   If the frontend doesn't have these endpoints wired yet (Build Guide may have specified what the backend should expose without the frontend yet consuming them), default to the architecture's specified shapes.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Half A — schema delta + derive.ts extension + job retrofit

### 1.1 Schema delta — add at minimum `costBasis` to BalanceSnapshot [LOCKED unless docx says otherwise]

The architecture's BalanceSnapshot rep is the source of truth. Stage 13's transcript only confirmed `value` exists; the rep likely also wants:
- `costBasis` (cumulative net-deposit at snapshot time — needed for PnL chart)
- `unrealizedPnl` (= value − costBasis, denormalized for query speed; could also be computed on-the-fly in DTOs)

Apply both as nullable VARCHAR columns (matching the prevailing currency-as-string convention used by `value`):

```sql
ALTER TABLE "balance_snapshot" ADD COLUMN "costBasis"     VARCHAR(50);
ALTER TABLE "balance_snapshot" ADD COLUMN "unrealizedPnl" VARCHAR(50);
```

All nullable. Historical snapshots (the ones already written by Stage 13 between the deploy and this stage) get NULL for both columns. Going forward, every new row has both populated. DTOs return null when the column is null; frontend treats null as "data not available for this period."

Apply via the established Neon pattern (`prisma db execute` + `prisma migrate resolve --applied` + `prisma generate`).

If the architecture docx specifies additional columns (`realizedPnl`, `assetCount`, etc.), add those too. If it specifies fewer (e.g., only `costBasis`, with unrealizedPnl computed on-the-fly), apply only what's specified. STOP gate 1 governs ambiguity.

### 1.2 Extend `computeDerived(portfolioId)` [LOCKED]

Current behavior per Stage 13 transcript: returns `{ totalValue, ...pnlFieldsAll0 }`. Replace the hardcoded zeros with real computations.

**costBasis** — sum of `Asset.netDeposit` across all the portfolio's assets. The `netDeposit` field on Asset is already maintained by Stage 9A's transaction recalc (`buy` adds, `sell` subtracts) and Stage 11's webhook bypass. It's the cumulative dollar amount the user has committed to that portfolio's holdings. Sum across all the portfolio's assets → portfolio-level costBasis.

**unrealizedPnl** — `totalValue − costBasis`, computed as a Prisma `Decimal` to avoid float drift, then formatted as a string for the API.

Both stay as `string` types in the return value (matches the `value`/`netDeposit` convention).

Update the return type and all callers. The callers per memory: Stage 13's job (`runSnapshotJob`), Stage 8's portfolio detail endpoint (already returns `totalValue` to the frontend; now also returns `costBasis` + `unrealizedPnl`).

Be careful: extending `computeDerived` ripples into Stage 8's portfolio DTO. If the portfolio detail rep already has `costBasis`/`unrealizedPnl` fields returning 0 (because derive.ts was already producing them), now they return real values. That's a behavior change to existing tests — update the assertions, don't paper over.

### 1.3 Retrofit Stage 13's job to persist the new fields [LOCKED]

In `src/jobs/snapshot.job.ts`, extend the upsert:

```ts
await prisma.balanceSnapshot.upsert({
  where: { portfolioId_snapshotDate: { portfolioId, snapshotDate } },
  create: {
    portfolioId,
    userId: portfolio.userId,
    snapshotDate,
    value: derived.totalValue,
    costBasis: derived.costBasis,
    unrealizedPnl: derived.unrealizedPnl,
  },
  update: {
    value: derived.totalValue,
    costBasis: derived.costBasis,
    unrealizedPnl: derived.unrealizedPnl,
  },
});
```

No drop_chunks change. No cron change. Same single-row-per-portfolio-per-day semantics.

### 1.4 Historical data is NOT backfilled [LOCKED]

The few snapshots Stage 13 has already written between its deploy and this stage have NULL `costBasis` and `unrealizedPnl`. Don't try to backfill — we don't have historical Token prices (only `currentPrice`), so any backfill would be a fabrication. Frontend renders null as "data not available."

Add a one-liner to the doc-fix pile: "Architecture should note that snapshots before Stage 14 deploy have NULL PnL fields; charts gracefully render that gap."

## 2. Half B — analytics endpoints

### 2.1 Endpoint list [PRELIMINARY — verify against docx + frontend in §0 step 7]

My best estimate of what the dashboard needs:

```
GET /portfolios/:portfolioId/snapshots                      # raw list, paginated
GET /portfolios/:portfolioId/snapshots/series?period=1m     # time-bucketed for charts
GET /portfolios/:portfolioId/snapshots/allocation           # current asset breakdown
GET /portfolios/:portfolioId/snapshots/performance          # roi/total-return summary
```

All four mounted as a nested router under `/portfolios/:portfolioId/snapshots`. Pattern matches Stage 12's NFTs nesting.

If the docx specifies a different shape (e.g., `/analytics/series` at portfolio root, or a single `/analytics` returning everything in one response), follow the docx. Surface as STOP gate 2 if the surface is genuinely ambiguous.

### 2.2 Common middleware [LOCKED]

All four endpoints:
1. `requireAuth`
2. `requirePlan(['pro'])` — analytics is the second canonical Pro-only feature. Free users get 403 PLAN_LIMIT_REACHED.
3. Portfolio-ownership middleware (nested-router pattern, same as Stage 8 / Stage 12).

Manual vs connected portfolios: both get analytics (unlike NFTs which are connected-only). The chart shows whatever's been snapshotted, regardless of how transactions got there.

### 2.3 `GET /portfolios/:id/snapshots` — paginated list

Query params:
- `limit` (default 50, max 365 — one year of daily snapshots)
- `offset` (default 0)

Returns:
```json
{
  "data": {
    "snapshots": [<SnapshotDTO>, ...]
  },
  "meta": {
    "total": <int>,
    "limit": <int>,
    "offset": <int>
  }
}
```

Ordered by `snapshotDate DESC`. `SnapshotDTO` has `{ id, portfolioId, snapshotDate, value, costBasis, unrealizedPnl }`.

### 2.4 `GET /portfolios/:id/snapshots/series?period=X` — time-bucketed series

Query param:
- `period` (one of `1m`, `3m`, `6m`, `1y`, `all`). Validate via Zod enum. Invalid → 400 VALIDATION_ERROR.

Returns:
```json
{
  "data": {
    "period": "1m",
    "series": [
      { "date": "2026-05-14", "value": "12500.00", "costBasis": "10000.00", "unrealizedPnl": "2500.00" },
      ...
    ]
  }
}
```

`series` is sorted by `date ASC` (chart x-axis convention). Each row is one snapshot.

Period → date-range mapping:
- `1m` → last 30 days
- `3m` → last 90 days
- `6m` → last 180 days
- `1y` → last 365 days
- `all` → no lower bound (returns everything since first snapshot)

No bucketing/aggregation needed at MVP — Stage 13 writes one row per day, so the natural daily granularity matches what the chart wants. If a period has too many points for the chart (e.g., 2y of daily data), the frontend can downsample client-side. Don't pre-emptively add server-side bucketing.

For periods longer than the user's snapshot history (e.g., user joined 2 weeks ago and asks for `1y`), return whatever exists. Don't pad with nulls.

### 2.5 `GET /portfolios/:id/snapshots/allocation` — current allocation

This isn't strictly a snapshot endpoint — it reads from current Asset rows, not from BalanceSnapshot history. But it fits naturally in the same controller and is what the allocation pie chart needs.

Returns:
```json
{
  "data": {
    "allocation": [
      { "tokenId": 1, "symbol": "BTC", "name": "Bitcoin", "value": "186000", "percentage": "62.5", "logoUrl": "..." },
      { "tokenId": 2, "symbol": "ETH", "name": "Ethereum", "value": "100000", "percentage": "33.6", ... },
      ...
    ],
    "totalValue": "297500"
  }
}
```

Logic:
1. Load portfolio's Assets with Token relations.
2. For each Asset: `value = balance × Token.currentPrice` (decimal multiplication, formatted as string).
3. Compute `totalValue = sum(value)`.
4. For each Asset: `percentage = (value / totalValue) × 100`, formatted to 1 decimal place.
5. Sort by `value DESC` (largest holding first — natural pie chart legend order).
6. Skip assets with `balance = 0` (sold-out positions shouldn't clutter the chart).

If `totalValue === 0` (empty portfolio): return `{ allocation: [], totalValue: "0" }`. No divide-by-zero.

### 2.6 `GET /portfolios/:id/snapshots/performance` — summary

Returns:
```json
{
  "data": {
    "totalValue": "297500",
    "costBasis": "240000",
    "totalReturn": "57500",
    "totalReturnPercentage": "23.96",
    "firstSnapshotDate": "2026-04-01",
    "snapshotCount": 74
  }
}
```

Logic:
1. Load latest snapshot (most recent `snapshotDate`) for the portfolio.
2. From it: `totalValue`, `costBasis`. If latest snapshot's `costBasis` is null (historical pre-Stage-14 row), fall back to computeDerived's live value.
3. `totalReturn = totalValue - costBasis`.
4. `totalReturnPercentage = (totalReturn / costBasis) × 100`, formatted to 2 decimals. Handle costBasis = 0 (no deposits yet): return "0.00".
5. Aggregate: `firstSnapshotDate` (min snapshotDate), `snapshotCount` (count of rows).

If no snapshots exist (Pro user but no portfolio days yet): return `{ totalValue: "0", costBasis: "0", totalReturn: "0", totalReturnPercentage: "0.00", firstSnapshotDate: null, snapshotCount: 0 }`. Don't 404.

## 3. Module scope

Half A:
```
prisma/schema.prisma                                    # EDIT — add 2 columns to BalanceSnapshot
prisma/migrations/<ts>_snapshot_costbasis_pnl/...       # NEW — hand-written
src/modules/portfolios/derive.ts                        # EDIT — compute costBasis + unrealizedPnl
src/jobs/snapshot.job.ts                                # EDIT — persist new fields
src/modules/portfolios/portfolios.dto.ts (or similar)   # MAYBE EDIT — if portfolio detail rep now exposes the real values
tests/snapshots.test.ts                                 # EDIT — test 296's assertion now checks costBasis + unrealizedPnl too
tests/portfolios.test.ts                                # MAYBE EDIT — if any existing test asserts costBasis: 0 or similar
```

Half B:
```
src/modules/snapshots/snapshots.controller.ts           # NEW — nested router
src/modules/snapshots/snapshots.service.ts              # NEW — listSnapshots, getSeries, getAllocation, getPerformance
src/modules/snapshots/snapshots.repository.ts           # NEW — Prisma queries
src/modules/snapshots/snapshots.dto.ts                  # NEW — toSnapshotDTO + toAllocationItemDTO + period parsing
src/app.ts                                              # EDIT — mount nested router
tests/snapshots-api.test.ts                             # NEW — ~10 tests for the 4 endpoints
```

Keep `tests/snapshots.test.ts` (Stage 13's job tests) separate from `tests/snapshots-api.test.ts` (Stage 14's endpoint tests) — different concerns, different setup overhead.

## 4. Tests (Vitest, integration — `tests/snapshots-api.test.ts`)

Test numbering 302–315. ~14 tests for Half B.

302. **GET /snapshots paginated as Pro user with 100 historical snapshots → 200, data.snapshots.length=50, meta.total=100, meta.limit=50, meta.offset=0; DESC date ordering.**
303. **GET /snapshots ?limit=20&offset=40 → data.snapshots.length=20, meta.offset=40.**
304. **GET /snapshots ?limit=500 → 400 VALIDATION_ERROR (max 365).**
305. **GET /snapshots as Free user → 403 PLAN_LIMIT_REACHED.**
306. **GET /snapshots/series?period=1m → 200, series sorted ASC, only last 30 days.**
307. **GET /snapshots/series?period=all → 200, series contains all snapshots.**
308. **GET /snapshots/series?period=invalid → 400 VALIDATION_ERROR.**
309. **GET /snapshots/series with no snapshots (new Pro user) → 200 with series: [].**
310. **GET /snapshots/allocation → returns assets sorted by value DESC, percentages sum to ~100 (within rounding), zero-balance assets excluded.**
311. **GET /snapshots/allocation on empty portfolio → 200 with allocation: [], totalValue: "0".**
312. **GET /snapshots/performance → totalReturn = value − costBasis, percentage correctly formatted; firstSnapshotDate and snapshotCount aggregated.**
313. **GET /snapshots/performance on portfolio with costBasis=0 → totalReturnPercentage: "0.00" (no divide-by-zero).**
314. **GET /snapshots/performance with no snapshots → 200 with zeros + null firstSnapshotDate.**
315. **All four endpoints as another user's portfolio → 403 FORBIDDEN (portfolio middleware handles).**

Plus a Half A test update:
- In `tests/snapshots.test.ts` test 296: replace the single `value` assertion with `value + costBasis + unrealizedPnl` assertions. Compute expected values from seeded BTC×price minus netDeposit setup.

Total after Stage 14: ~315 tests.

## 5. STOP-AND-ASK gates

1. **BalanceSnapshot rep in the architecture docx adds MORE than costBasis + unrealizedPnl.** If it specifies `realizedPnl`, `assetCount`, `topPerformer`, or anything I didn't enumerate, surface the full list and ask which to include in Half A vs defer.
2. **Endpoint shape in docx materially differs from §2.1.** If the docx specifies (e.g.) a single `/analytics` returning everything in one response, OR uses different query params (`?range=` instead of `?period=`, or numeric days instead of named periods), STOP and surface. The frontend's API client confirms the expected URL/param shape.
3. **Frontend already has analytics endpoints stubbed/mocked** but expecting a different URL prefix (e.g., `/api/v1/portfolios/:id/analytics/*` instead of `/snapshots/*`). Either is reasonable — pick the one the frontend already expects and surface.
4. **costBasis already wired through Stage 8's derive.ts.** If `computeDerived` already returns a real `costBasis` (not zeros), then Stage 8's portfolio detail tests may already assert it. Surface and confirm before changing — Half A's "extend derive" may already be done.
5. **Time-bucketed downsampling is required.** If the docx specifies (e.g.) weekly bucketing for the 1y period or monthly bucketing for `all`, surface — server-side bucketing changes the query shape significantly. My default is "one snapshot row = one chart point, no server-side bucketing."
6. **Decimal arithmetic precision.** Stage 14's percentages and totals should use Prisma `Decimal` throughout for correctness. If any existing helper rounds via `Number()` first, that's a latent bug to flag (not necessarily fix here).

## 6. What NOT to do

- **No backfilling historical snapshot costBasis/unrealizedPnl.** §1.4. Pre-Stage-14 rows stay NULL forever.
- **No new write endpoints.** Snapshots are written by Stage 13's job only.
- **No allocation history endpoint.** Allocation reads current state only. If the architecture docx specifies an allocation-history chart, surface as a new STOP gate — that requires capturing per-token snapshots, a much bigger schema change.
- **No background recompute job triggered by user actions.** Stage 13's daily cron is the only writer.
- **No cache for analytics responses.** They're cheap reads off the snapshot table. Premature optimization. Stage 15 or post-launch can revisit if needed.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 7. Commit and report

```bash
git add -A
git commit -m "feat(analytics): Stage 14 — BalanceSnapshot costBasis/PnL columns + analytics endpoints (snapshots list, series, allocation, performance)"
git log --oneline -5
```

Or split into 2 commits (Half A schema/derive/job retrofit + Half B endpoints) for cleaner history. Either is fine.

Report:
- New commit SHA(s).
- Confirmation Half A schema delta applied (`prisma migrate status` shows the new migration as applied).
- Confirmation `computeDerived(portfolioId)` now returns real `costBasis` and `unrealizedPnl` (one example portfolio's actual numbers).
- Confirmation Stage 13's job writes all three columns going forward (run `runSnapshotJob()` once against the dev DB and show the row).
- One curl per endpoint (snapshots list happy path, series 1m happy path, allocation happy path, performance happy path, plus a free-user 403 on any of them).
- Vitest output: all ~315 tests passing.
- Number of pre-Stage-14 historical snapshot rows that exist with NULL `costBasis`/`unrealizedPnl` (just a count for awareness; do not backfill).
- Doc-fix pile items added in Stage 14:
  - `Neonfi Database Schema.docx` BalanceSnapshot: add the new columns (whichever Half A applied).
  - `Neonfi System Architecture.docx`: note that snapshots before Stage 14 deploy have NULL PnL fields.
  - Whichever endpoint URL/shape divergence was resolved against the docx (if any).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
