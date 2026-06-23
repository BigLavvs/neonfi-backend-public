# Neonfi backend — Stage 14 (v2): Analytics endpoints

This file is the source-of-truth intent for Stage 14, rewritten from scratch after the audit. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 38dddbd (retrofit-3).

**Note on history**: an earlier `_claude/stage-14.md` exists in the repo. It is **WRONG** (the audit found it specified wrong URLs, wrong shapes, wrong module name, and a fabricated schema delta). **Do not read or follow it**. This file (`stage-14-v2.md`) is the corrected version. After Stage 14 lands, the old `stage-14.md` can be deleted (or kept as a historical artifact — Idowu's call). Don't bundle it in this commit either way.

What ships here:
- `src/modules/analytics/` module (controller, service, dto) — `analytics/` is mandated by implementation.txt §4 line 108 and architecture.txt §Analytics Module line 1194
- Three endpoints exactly: `GET /api/v1/analytics/:portfolioId/{summary,performance,holdings}` — verified against architecture.txt line 633-636 and frontend `endpoints.ts:21`
- Three response shapes EXACTLY as the architecture reps (architecture.txt line 642-669) — every field name and key matters; the frontend `/performance` page consumes them
- 5-min Redis cache per endpoint per Build Guide §2.5 + architecture.txt line 1207
- Cache invalidation hooks extended into existing transactions.service.ts (retrofit-2) and snapshot.job.ts (retrofit-3)
- Cross-module read pattern: analytics calls snapshots.service, transactions.service, and assets via clean helper boundaries (architecture.txt line 1262-1263 module isolation)

Out of scope: Stage 15 email retries (separate prompt). The earlier wrong `stage-14.md` file (leave untracked).

## 0. Read first

This stage spans 5 modules and adds 1 new one. Reading first is critical. Cite file:line when in doubt.

1. `Neonfi System Architecture.docx` via the text export `docs/architecture.txt` in the frontend repo (`C:\Users\pelum\Desktop\Neonfi\docs\architecture.txt`):
   - **ANALYTICS entity (line 630-669)** — endpoint list, three resource reps. THE source of truth for response shapes.
   - **Analytics Module (line 1194-1212)** — module rules.
   - **§9 CACHING CONVENTIONS line 887-893** — TTL, invalidation triggers.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo) — **§Stage 14 in §3, §2.5 (caching).** Reaffirms what architecture says.
3. `C:\Users\pelum\Desktop\Neonfi\src\lib\endpoints.ts` — frontend's authoritative endpoint inventory. `analytics: { summary: (id) => /analytics/${id}/summary }` confirms top-level routing (NOT nested under /portfolios).
4. `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\performance\+page.svelte` — the consumer. Read what fields it reads from `data.heroStats.allTimePnlPositive` / `data.heroStats.allTimePnlValue` / `data.heroStats.allTimePnlPct` / `data.heroStats.totalDeposits` / `data.heroStats.totalWithdrawals`. The mapping from API response → page data may happen in the page's `+page.server.ts` (mostly mock right now). Confirm the field names on the API side match the architecture rep (which they should — the page is presumably already aligned).
5. `src/modules/nfts/nfts.controller.ts` — the established Pro-only + portfolio-ownership middleware chain template. Mirror exactly.
6. `src/modules/snapshots/{repository,service,dto,controller}.ts` from retrofit-3 — the module template Stage 14 mirrors.
7. `src/modules/portfolios/derive.ts` (after retrofit-3) — analytics summary reuses `computeDerived` for `totalValue` and `pnlAllTime{Value}`. Cache key is `portfolio_pnl:<id>`.
8. `src/modules/transactions/transactions.service.ts` (after retrofit-2; lines 30-45 for `invalidatePnlCache` + the four mutation paths that call it) — you'll extend `invalidatePnlCache` to also flush `analytics_*:<id>`.
9. `src/jobs/snapshot.job.ts` (after retrofit-3; the per-upsert `redis.del('portfolio_pnl:<id>')` block) — same extension needed.
10. `src/modules/assets/assets.dto.ts` (after retrofit-2) — `toAssetDTO` and `computeTotalValue` helpers. Stage 14 holdings reuses them.
11. `tests/helpers.ts` (after retrofit-3; the `portfolio_pnl:*` flush block) — same pattern, extended for `analytics_*:*` flush.

## 1. Architecture decisions

### 1.1 New `analytics/` module — 3 files [LOCKED]

```
src/modules/analytics/
  analytics.dto.ts            # 3 DTOs (Summary, Performance, Holdings)
  analytics.service.ts        # business logic composing snapshots + transactions + assets
  analytics.controller.ts     # 3 endpoints, Pro-gated, portfolio-ownership middleware
```

No `analytics.repository.ts` — the module owns no tables. Architecture line 1211: "Entities owned: None, reads from BalanceSnapshot and Asset."

### 1.2 Three endpoints, top-level under `/api/v1/analytics` [LOCKED]

Routes mounted at `/api/v1/analytics` (NOT nested under `/portfolios`). Each route's path param is `:portfolioId`. The controller's middleware loads the Portfolio and enforces ownership.

```
GET /api/v1/analytics/:portfolioId/summary
GET /api/v1/analytics/:portfolioId/performance
GET /api/v1/analytics/:portfolioId/holdings
```

Middleware chain for all three (same as nfts.controller.ts:20-34): `requireAuth` → `requirePlan(['pro'])` → portfolio-ownership middleware. Use `findPortfolioById` from portfolios.repository for the ownership lookup. Set `c.set('portfolio', portfolio)` so handlers access it via `c.get('portfolio')`.

If the portfolio is missing or not owned: `403 FORBIDDEN`. Architecture privacy rule for analytics (line 673-675): "Current user (own analytics): 200; Others: 403."

### 1.3 Resource representations — EXACTLY from architecture [LOCKED]

These shapes are not negotiable. The frontend reads exactly these keys.

**Summary** (architecture.txt line 640-652):
```ts
export interface SummaryDTO {
  portfolioId: number;
  allTimePnlPct: number;        // e.g. 13.8 — percent change vs netDeposit
  allTimePnlValue: number;      // e.g. 1233.37 — absolute USD delta
  totalDeposits: number;        // e.g. 8900.00 — sum of buy usdValue
  totalWithdrawals: number;     // e.g. 1420.50 — sum of sell usdValue
  pnl7d: number;                // percent: ((today - 7d_ago) / 7d_ago) * 100
  pnl7dValue: number;           // absolute: today - 7d_ago
  pnl30d: number;               // percent: ((today - 30d_ago) / 30d_ago) * 100
  pnl30dValue: number;          // absolute: today - 30d_ago
}
```

**Performance** (architecture.txt line 654-661):
```ts
export interface PerformanceDTO {
  portfolioId: number;
  snapshots: Array<{ date: string; value: number }>;  // date as YYYY-MM-DD, ASC by date (chart-friendly)
}
```

**Holdings** (architecture.txt line 663-669):
```ts
export interface HoldingsDTO {
  portfolioId: number;
  assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
}
```

Match these shapes byte-for-byte. The architecture rep example shows `"portfolioPercentage": 44` (integer); preserve `number` type — round only if frontend explicitly requires it. Current AssetDTO returns unrounded numbers, so match that.

**Note on `allTimePnlPositive`**: the frontend's performance page mock (`performance/+page.ts:32-38`) includes an `allTimePnlPositive: true` boolean alongside `allTimePnlValue`/`allTimePnlPct`. This is **NOT** an API field — it's a one-line derivation the page's `+page.ts` computes from `allTimePnlValue >= 0` for CSS class binding (`+page.svelte:202-207` uses it for `class:gain` / `class:loss`). Do not add `allTimePnlPositive` to SummaryDTO. The architecture rep is the contract; the frontend derives the boolean. Same pattern for any other `*Positive` booleans the frontend may add: derivation lives in `+page.ts`, not the API.

**Note on per-token daily performance (page mock `dailyPerformance` array)**: the page mock includes a 5-row table of per-token `d1/d7/d30` price changes. This is OUT OF SCOPE for Stage 14 — none of the three analytics endpoints return per-token historicals. The 24h column will be wired from Coinbase WS `change24h` (Stage 10A's price feed). 7d/30d per token has no architecture-defined source (we don't snapshot Token.currentPrice over time). This is a documented MVP gap, not a Stage 14 obligation. Leave it for post-MVP. If Claude Code reads the frontend and worries about coverage here, the answer is: doesn't ship in Stage 14, frontend will hide or mock those columns until a future Token-snapshot retrofit.

### 1.4 Summary endpoint logic [LOCKED]

```ts
async function buildSummary(portfolioId: number): Promise<SummaryDTO> {
  // 1. allTime* from derive.ts (already cached at portfolio_pnl:<id>)
  const derived = await computeDerived(portfolioId);
  
  // 2. totalDeposits/totalWithdrawals from transactions service
  const { totalDeposits, totalWithdrawals } = await getDepositWithdrawalTotals(portfolioId);
  
  // 3. 7d/30d PnL from snapshot history
  const todayValue = derived.totalValue;
  const [snap7d, snap30d] = await Promise.all([
    findSnapshotNearDaysAgo(portfolioId, 7),
    findSnapshotNearDaysAgo(portfolioId, 30),
  ]);
  
  // Guard against no historical data — returns 0 for both fields if no snapshot found.
  const [pnl7d, pnl7dValue] = computePnlPeriod(todayValue, snap7d?.value ?? null);
  const [pnl30d, pnl30dValue] = computePnlPeriod(todayValue, snap30d?.value ?? null);
  
  return {
    portfolioId,
    allTimePnlPct: derived.pnlAllTime,
    allTimePnlValue: derived.pnlAllTimeValue,
    totalDeposits,
    totalWithdrawals,
    pnl7d,
    pnl7dValue,
    pnl30d,
    pnl30dValue,
  };
}

function computePnlPeriod(today: number, pastValue: number | null): [number, number] {
  if (pastValue === null || pastValue === 0) return [0, 0];
  const delta = today - pastValue;
  const pct = (delta / pastValue) * 100;
  return [pct, delta];
}
```

`findSnapshotNearDaysAgo` is a new snapshots service helper (§1.7). Returns the most recent snapshot AT OR BEFORE `today - N days`. Returns null if no snapshot in that window.

`getDepositWithdrawalTotals` is a new transactions service helper (§1.7). Sums `usdValue` from native + erc20 details, grouped by direction. NFT transactions don't contribute.

### 1.5 Performance endpoint logic [LOCKED]

```ts
async function buildPerformance(portfolioId: number): Promise<PerformanceDTO> {
  // Read all snapshots via snapshots service, ASC by date for chart-friendly ordering
  const snapshots = await findAllSnapshotsAscByPortfolio(portfolioId);
  return {
    portfolioId,
    snapshots: snapshots.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: Number(s.value.toString()),
    })),
  };
}
```

No pagination — performance is a one-shot fetch of the full timeseries. If a portfolio has 730 days of snapshots (the retention max), that's still a tiny payload (~50KB JSON). Frontend can downsample for display. No query params.

`findAllSnapshotsAscByPortfolio` is a new snapshots service helper (§1.7).

### 1.6 Holdings endpoint logic [LOCKED]

```ts
async function buildHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  const assets = await findAllAssetsByPortfolioId(portfolio.id);
  const totalValue = computeTotalValue(assets);
  
  // Filter zero-balance, compute (symbol, value, percentage) per asset, sort by value DESC
  const items = assets
    .map((a) => {
      const balance = Number(a.balance.toString());
      const price = Number(a.token.currentPrice.toString());
      return { symbol: a.token.symbol, balance, price };
    })
    .filter((a) => a.balance > 0)
    .map((a) => {
      const value = a.balance * a.price;
      const portfolioPercentage = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return { symbol: a.symbol, value, portfolioPercentage };
    })
    .sort((a, b) => b.value - a.value);
  
  return { portfolioId: portfolio.id, assets: items };
}
```

Uses `findAllAssetsByPortfolioId` and `computeTotalValue` already exported from `assets/`. The Asset module is the right boundary for asset reads — this counts as a clean service call. No new helpers needed.

Empty portfolio: returns `{ portfolioId, assets: [] }`. Sort is stable in modern V8; symbol ties are rare.

### 1.7 New service helpers [LOCKED — minimal cross-module surface]

These expose the cross-module reads analytics needs. Each is small and lives in the module that owns the data.

**`snapshots.service.ts`** — add two helpers:
```ts
/**
 * Returns the most recent snapshot at or before `today - daysAgo`. Used by
 * Stage 14 analytics to compute pnl7d / pnl30d (architecture line 644-651).
 * Returns null if no snapshot in that window.
 */
export async function findSnapshotNearDaysAgo(
  portfolioId: number,
  daysAgo: number,
): Promise<{ value: Prisma.Decimal } | null> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysAgo);
  // Use date-only for comparison (column is @db.Date) — strip time component
  const cutoffYmd = cutoff.toISOString().slice(0, 10);
  return prisma.balanceSnapshot.findFirst({
    where: { portfolioId, snapshotDate: { lte: new Date(`${cutoffYmd}T00:00:00.000Z`) } },
    orderBy: { snapshotDate: 'desc' },
    select: { value: true },
  });
}

/**
 * All snapshots for the portfolio, ASC by date. Used by Stage 14 performance
 * endpoint (architecture line 654-661). Returns the lean fields only.
 */
export async function findAllSnapshotsAscByPortfolio(
  portfolioId: number,
): Promise<Array<{ snapshotDate: Date; value: Prisma.Decimal }>> {
  return prisma.balanceSnapshot.findMany({
    where: { portfolioId },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, value: true },
  });
}
```

**`transactions.service.ts`** — add one helper:
```ts
/**
 * Returns total USD deposits (sum of buy usdValue across native + erc20) and
 * total USD withdrawals (sum of sell). NFT transactions don't contribute (no
 * usdValue). Used by Stage 14 analytics summary endpoint (architecture line
 * 646-647).
 */
export async function getDepositWithdrawalTotals(
  portfolioId: number,
): Promise<{ totalDeposits: number; totalWithdrawals: number }> {
  const [nativeBuys, nativeSells, erc20Buys, erc20Sells] = await Promise.all([
    prisma.nativeTransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'buy' } } },
      _sum: { usdValue: true },
    }),
    prisma.nativeTransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'sell' } } },
      _sum: { usdValue: true },
    }),
    prisma.erc20TransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'buy' } } },
      _sum: { usdValue: true },
    }),
    prisma.erc20TransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'sell' } } },
      _sum: { usdValue: true },
    }),
  ]);
  const toNum = (d: { _sum: { usdValue: Prisma.Decimal | null } }) =>
    d._sum.usdValue ? Number(d._sum.usdValue.toString()) : 0;
  return {
    totalDeposits: toNum(nativeBuys) + toNum(erc20Buys),
    totalWithdrawals: toNum(nativeSells) + toNum(erc20Sells),
  };
}
```

Document each helper's purpose in a JSDoc comment so future readers understand why the cross-module surface exists.

### 1.8 Cache: three keys per portfolio, 5-min TTL each [LOCKED]

Keys:
- `analytics_summary:<portfolioId>`
- `analytics_performance:<portfolioId>`
- `analytics_holdings:<portfolioId>`

TTL: 300 seconds (5 min) — Build Guide §2.5, architecture line 1207.

Each endpoint handler: cache GET → parse JSON → return on hit. On miss: compute, write back to cache with `.catch`-guarded `redis.set`. Mirror derive.ts's pattern (retrofit-3 §1.5) but with separate keys.

Wrap the cache logic in a small helper to avoid copy-paste across three endpoints:

```ts
// In analytics.service.ts or a dedicated cache module:
async function withCache<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as T;
      return parsed;
    } catch {
      // fall through
    }
  }
  const result = await compute();
  await redis.set(key, JSON.stringify(result), 'EX', 300).catch((e: Error) =>
    console.error(`[analytics] cache set failed for ${key}:`, e.message),
  );
  return result;
}
```

### 1.9 Cache invalidation: extend existing hooks [LOCKED]

Both retrofit-2's transactions.service.invalidatePnlCache and retrofit-3's per-upsert hook in snapshot.job.ts currently delete only `portfolio_pnl:<id>`. Extend each to also delete the three analytics keys.

Two options:

**Option A — inline the four `del`s.** Duplicates the key list across two files; easy to keep consistent.

**Option B — extract a shared helper** in `src/lib/portfolio-cache-keys.ts` (or `src/lib/cache-keys.ts`):
```ts
export function portfolioDerivedCacheKeys(portfolioId: number): string[] {
  return [
    `portfolio_pnl:${portfolioId}`,
    `analytics_summary:${portfolioId}`,
    `analytics_performance:${portfolioId}`,
    `analytics_holdings:${portfolioId}`,
  ];
}
```

Then both callers use:
```ts
await redis.del(...portfolioDerivedCacheKeys(portfolioId)).catch(...);
```

**Pick Option B.** One source of truth for the key list. When Stage 15 or later adds another derived cache, only one file changes.

### 1.10 Test helper extension [LOCKED]

Update `truncateAllUserData` in `tests/helpers.ts` to also flush `analytics_*:*` alongside the existing `portfolio_pnl:*` flush (retrofit-3 §1.5). Same reason: TRUNCATE resets portfolio id sequences, but Redis keys persist with stale values.

Refactor to use a single `redis.keys('portfolio_pnl:*')` + `redis.keys('analytics_*:*')` pair, OR (cleaner) a single pattern match like `redis.keys('*:*')` filtered to known prefixes. I'd go with the two-pattern approach for clarity:

```ts
// In truncateAllUserData, replacing the current portfolio_pnl:* flush:
const derivedKeys = (await Promise.all([
  redis.keys('portfolio_pnl:*'),
  redis.keys('analytics_summary:*'),
  redis.keys('analytics_performance:*'),
  redis.keys('analytics_holdings:*'),
])).flat();
if (derivedKeys.length > 0) await redis.del(derivedKeys);
```

## 2. Module scope

```
src/modules/analytics/analytics.dto.ts                    # NEW — 3 DTOs
src/modules/analytics/analytics.service.ts                # NEW — buildSummary, buildPerformance, buildHoldings + withCache helper
src/modules/analytics/analytics.controller.ts             # NEW — 3 endpoints + middleware chain
src/app.ts                                                # EDIT — mount /analytics router
src/lib/portfolio-cache-keys.ts                           # NEW — single source for derived cache keys
src/modules/snapshots/snapshots.service.ts                # EDIT — add findSnapshotNearDaysAgo + findAllSnapshotsAscByPortfolio
src/modules/transactions/transactions.service.ts          # EDIT — add getDepositWithdrawalTotals + use portfolioDerivedCacheKeys in invalidatePnlCache
src/jobs/snapshot.job.ts                                  # EDIT — use portfolioDerivedCacheKeys in the per-upsert hook
tests/helpers.ts                                          # EDIT — flush all derived cache keys in truncateAllUserData
tests/analytics.test.ts                                   # NEW — endpoint tests
```

No schema delta. No migration. No new env vars.

## 3. Tests (Vitest, integration — new file `tests/analytics.test.ts`)

Test numbering continues from 325. Aim for 11 new tests.

326. **GET /summary happy path: Pro user with 1 BTC asset (totalValue ≈ 93000), netDeposit=80000, 7d-ago snapshot value=85000, 30d-ago snapshot value=70000. Buy txn for $80k, sell txn for $5k. → 200 with `allTimePnlValue ≈ 13000`, `allTimePnlPct ≈ 16.25`, `totalDeposits = 80000`, `totalWithdrawals = 5000`, `pnl7dValue ≈ 8000`, `pnl7d ≈ 9.41`, `pnl30dValue ≈ 23000`, `pnl30d ≈ 32.86`.** Seed via prisma. Verify shape includes exactly the 9 keys.

327. **GET /summary with no historical snapshots → pnl7d/pnl7dValue/pnl30d/pnl30dValue all 0.** allTime fields still populate from current state.

328. **GET /summary with netDeposit=0 → allTimePnlPct=0** (divide-by-zero guard from derive.ts). allTimePnlValue equals totalValue.

329. **GET /performance happy path: 3 snapshots seeded across 3 dates. → 200 with `data.snapshots` array of 3, ASC by date, each `{ date: "YYYY-MM-DD", value: number }`.**

330. **GET /performance on portfolio with no snapshots → 200 with empty `data.snapshots` array.**

331. **GET /holdings happy path: 2 assets (BTC 1.0 at 93000, ETH 2.0 at 3200). → 200 with assets sorted by value DESC (BTC first), portfolioPercentage roughly 93.55 / 6.45.** Verify exactly `{ symbol, value, portfolioPercentage }` per item.

332. **GET /holdings filters zero-balance assets.** Seed BTC=1.0, ETH=0. Returns only BTC.

333. **GET /holdings on empty portfolio → 200 with empty `data.assets` array.**

334. **All 3 endpoints as Free user → 403 PLAN_LIMIT_REACHED.**

335. **All 3 endpoints on another user's portfolio → 403 FORBIDDEN.**

336. **Cache hit on /summary: pre-populate `analytics_summary:<id>` with a sentinel value; subsequent GET returns the sentinel without DB recompute.** Mirror retrofit-3 test 321.

337. **Cache invalidation: GET /summary populates cache → POST a manual transaction → assert `analytics_summary:<id>` is gone from Redis (via redis.exists or redis.get → null).** Verifies the invalidation hook works end-to-end.

Adjusted total: 12 new tests. Final test count target: 337.

## 4. STOP-AND-ASK gates

1. **If the frontend's `+page.server.ts` maps API responses to different field names** (e.g. `allTimePnlPct` → `allTimePnlPositive: bool` somewhere), the API contract is correct per architecture — the frontend page is doing post-processing. Don't change the API.

2. **If snapshot-near-date returns the wrong day under timezone shift**, fall back to UTC-only arithmetic. The snapshot column is `@db.Date` so PostgreSQL stores midnight-UTC; constructing the cutoff with `new Date('YYYY-MM-DDT00:00:00.000Z')` keeps the comparison clean.

3. **If `getDepositWithdrawalTotals` aggregates are slow** under large transaction histories, an index on `(transaction.portfolioId, direction.name)` would help. The Transaction table already has indexes on `portfolioId` and `directionId` (schema lines 317, 319), so two-column composite isn't there. Surface if a test exposes slowness; don't add the index speculatively.

4. **If `withCache<T>` generic inference doesn't work cleanly** in TypeScript (e.g. type widening), explicit type args at the call site are fine. Don't fight the inference.

5. **If `portfolioDerivedCacheKeys` returning a spread into `redis.del(...keys)` confuses ioredis** (it shouldn't — ioredis del accepts variadic), pass as a single array argument: `redis.del(keys)`. ioredis accepts both forms.

6. **If existing snapshots.test.ts or transactions.test.ts tests break** because retrofit-2/retrofit-3 hooks now invalidate more keys, that's expected behavior — assertions on cache key sets need updating. The new invalidation is correct; don't back out.

## 5. What NOT to do

- **No edits to the wrong `_claude/stage-14.md` file**. Leave it untracked; this commit doesn't touch it.
- **No edits to derive.ts**. It's the source of `allTimePnl{Pct,Value}` already; analytics composes it. The `portfolio_pnl` cache is still derive's.
- **No new schema delta**. Everything analytics needs already exists in the model.
- **No new query params on /performance** (no `?period=`, no `?range=`). Return all snapshots; frontend filters.
- **No `Asset` direct query inside analytics module** outside the existing assets.dto helpers — keep boundary clean.
- **No editing architecture/schema docx.** Doc-fix items go in the report.
- **No bundling stage-14.md (the wrong file) OR stage-14-v2.md cross-purposes** — explicit staging avoids the same scope-leak retrofit-1 caught.
- **No `npm audit fix`.**

## 6. Commit and report

Stage explicitly:

```bash
git add src/modules/analytics/analytics.dto.ts \
        src/modules/analytics/analytics.service.ts \
        src/modules/analytics/analytics.controller.ts \
        src/app.ts \
        src/lib/portfolio-cache-keys.ts \
        src/modules/snapshots/snapshots.service.ts \
        src/modules/transactions/transactions.service.ts \
        src/jobs/snapshot.job.ts \
        tests/helpers.ts \
        tests/analytics.test.ts \
        _claude/stage-14-v2.md
git commit -m "feat(analytics): Stage 14 — GET /analytics/:id/{summary,performance,holdings} + cache + cross-module reads"
git log --oneline -5
```

Report:
- New commit SHA.
- Three curl-equivalent demonstrations via integration tests (mirror retrofit-3's pattern — no live server needed):
  - `/summary` happy path showing all 9 fields with non-zero values
  - `/performance` showing the snapshots array
  - `/holdings` showing assets sorted DESC
- Confirmation cache keys appear in Redis after first request, disappear after cache invalidation (test 336 + 337).
- Confirmation `portfolioDerivedCacheKeys` is the single source for all derived keys — grep proof.
- Vitest output: all tests passing (count expected ~337: 325 baseline + 12 new).
- Doc-fix pile items added in Stage 14:
  - `Neonfi System Architecture.docx` ANALYTICS section (optional): note that the analytics endpoints now exist; resource reps match.
  - The old `_claude/stage-14.md` is left untracked. Idowu can decide whether to delete it or keep it as a historical "what was wrong" reference.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
