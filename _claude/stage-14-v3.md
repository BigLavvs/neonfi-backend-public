# Neonfi backend — Stage 14 (v3): Analytics endpoints

This file is the source-of-truth intent for Stage 14, rewritten after a comprehensive scan of the frontend codebase, all four canonical docs, and the post-retrofit-3 backend state. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 38dddbd (retrofit-3).

**Note on prior versions**: `_claude/stage-14.md` (pre-audit, WRONG — fabricated schema delta + wrong URLs) and `_claude/stage-14-v2.md` (audit-corrected but written partly from memory) both exist in the repo. **Read neither.** This file (`stage-14-v3.md`) is anchored against files Idowu and I verified before writing. After Stage 14 lands, both prior files can be deleted — leave them untracked in this commit either way.

What ships here:
- `src/modules/analytics/` module (controller, service, dto) — implementation.txt line 108 mandates `analytics/` in the module structure
- Three endpoints exactly: `GET /api/v1/analytics/:portfolioId/{summary,performance,holdings}` (architecture.txt line 633-636; frontend `endpoints.ts:21` confirms top-level routing)
- Three response shapes EXACTLY as the architecture reps (architecture.txt line 642-669)
- 5-min Redis cache per endpoint (Build Guide §2.5, architecture line 1207)
- Cache invalidation hooks extended via new shared helper `portfolioDerivedCacheKeys(portfolioId)` used by transactions.service AND snapshot.job
- Cross-module reads through clean service helpers in the modules that own the data

Out of scope: Stage 15 email retries (separate prompt). Per-token daily performance table on the performance page (no architecture-defined source — see §1.11 MVP gap note).

## 0. Pre-verified state — what I already read

I read each of these before writing this prompt. Cite line numbers when you verify the same.

**Frontend (Build Guide §0.1 level 4 — consumed shape authority)**:
- `C:\Users\pelum\Desktop\Neonfi\src\lib\endpoints.ts:21` — `analytics: { summary: (id) => /analytics/${id}/summary }`. Top-level routing confirmed.
- `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\performance\+page.ts:27` — TODO names all three endpoints exactly.
- `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\dashboard\+page.ts:59` — TODO for analytics.summary, Pro-only.
- `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\performance\+page.svelte:202-207` — reads `data.heroStats.allTimePnlPositive` for CSS class binding; this is a `+page.ts`-derived boolean (`allTimePnlValue >= 0`), NOT an API field.
- `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\performance\+page.svelte:82-128` (`dailyPerformance` mock) — per-token `d1/d7/d30`. Out of scope (§1.11).
- `C:\Users\pelum\Desktop\Neonfi\src\hooks.server.ts:58-66` — `event.locals.session.plan: 'free'|'pro'`.
- `C:\Users\pelum\Desktop\Neonfi\src\routes\(dashboard)\+layout.svelte:31-40` — wires WS only for Pro users via `ENDPOINTS.auth.wsToken`. Confirms `plan` is the gating signal.
- `C:\Users\pelum\Desktop\Neonfi\src\lib\components\AreaChart.svelte:1-10` — props `{ points: number[], labels: string[] }`. Frontend maps `performance.snapshots[].value` → points, `.date` → labels.
- `C:\Users\pelum\Desktop\Neonfi\src\lib\components\DonutChart.svelte:2-16` — segments `{ label, value, colour }` where `value` is integer percentage. Frontend maps `holdings.assets[].portfolioPercentage` → value.
- `C:\Users\pelum\Desktop\Neonfi\src\lib\components\ProGate.svelte` — blurs children + overlay; frontend handles 403 client-side.
- `C:\Users\pelum\Desktop\Neonfi\src\lib\api.ts` — reads `{error: {code, message}}` on failures.

**Docs (Build Guide §0.1 levels 1-3)**:
- `Neonfi System Architecture.docx` via text export, ANALYTICS entity (architecture.txt:630-669) — endpoints + 3 reps verbatim. Analytics Module rules (line 1194-1212): owns nothing; reads BalanceSnapshot + Asset; 5-min Redis cache; invalidate on snapshot write.
- `Neonfi_Backend_Build_Guide.md` §Stage 14 (file at `C:\Users\pelum\Desktop\Neonfi\docs\Neonfi_Backend_Build_Guide.md`) — restates the above.
- `Neonfi System Implementation.docx` (implementation.txt:108 + 500-512) — `analytics/` module in src/modules tree; Performance page calls all three analytics endpoints.
- `Neonfi Database Schema.docx` — no Stage 14 schema impact. All data Stage 14 needs already exists after retrofit-2.

**Backend post-retrofit-3 state**:
- `src/modules/portfolios/derive.ts` (104 lines) — returns 9-field `DerivedFields`; `totalValue`, `pnlAllTime`, `pnlAllTimeValue` are real; 24h/7d/30d still 0. Cache at `portfolio_pnl:<id>`, 5-min TTL, GET/SET both `.catch`-guarded. Stage 14 SHOULD call computeDerived for the all-time numbers; no need to duplicate that logic.
- `src/modules/snapshots/snapshots.repository.ts` — exports `findSnapshotsByPortfolioId(portfolioId, filters)` (DESC by date) + `countSnapshotsByPortfolioId`. Stage 14 needs TWO new repository helpers (§1.7).
- `src/modules/snapshots/snapshots.service.ts` — single export `listPortfolioSnapshots`. Stage 14 adds TWO service-layer helpers (§1.7).
- `src/modules/snapshots/snapshots.controller.ts:27-41` — the exact middleware chain to mirror: `requireAuth` → `requirePlan(['pro'])` → portfolio-ownership middleware via `findPortfolioById`.
- `src/modules/transactions/transactions.service.ts:30-45` (after retrofit-2) — `invalidatePnlCache(portfolioId)` helper, currently deletes one key. Stage 14 refactors to use `portfolioDerivedCacheKeys`.
- `src/jobs/snapshot.job.ts:114-121` (after retrofit-3) — per-upsert `redis.del('portfolio_pnl:<id>')`. Stage 14 refactors same way.
- `tests/helpers.ts:61-69` (after retrofit-3) — `truncateAllUserData` flushes `portfolio_pnl:*` keys. Stage 14 extends to also flush `analytics_*:*`.
- `src/lib/constants.ts` — exports `SNAPSHOT_RETENTION_DAYS = 730`.
- `src/modules/assets/assets.dto.ts:53-59` (after retrofit-2) — `computeTotalValue(assets)` and `toAssetDTO`. Stage 14 holdings reuses `computeTotalValue`.
- `src/app.ts:51-57` — routing pattern; mount `/analytics` at `api.route('/analytics', analyticsRouter)`.

Read the same files yourself before editing — fresh state can drift from my notes. Each citation above is precise enough to grep.

## 1. Architecture decisions

### 1.1 New `analytics/` module — 3 files [LOCKED]

```
src/modules/analytics/
  analytics.dto.ts            # 3 DTOs (Summary, Performance, Holdings)
  analytics.service.ts        # business logic composing snapshots + transactions + assets
  analytics.controller.ts     # 3 endpoints, Pro-gated, portfolio-ownership middleware
```

No repository file — owns no tables.

### 1.2 Three endpoints, top-level under `/api/v1/analytics` [LOCKED — verified vs endpoints.ts:21]

```
GET /api/v1/analytics/:portfolioId/summary
GET /api/v1/analytics/:portfolioId/performance
GET /api/v1/analytics/:portfolioId/holdings
```

Middleware chain mirrors `snapshots.controller.ts:27-41` verbatim: `requireAuth` → `requirePlan(['pro'])` → portfolio-ownership (loads Portfolio via `findPortfolioById` from `portfolios.repository`, sets `c.set('portfolio', portfolio)`, 403 FORBIDDEN if missing/not-owned).

Free user *with an active free subscription* → `requirePlan` returns 403 PLAN_LIMIT_REACHED (plan.ts:46–51). Note `requirePlan` has two earlier 403 branches: no subscription row → SUBSCRIPTION_REQUIRED (plan.ts:31–32); subscription not effectively active → SUBSCRIPTION_EXPIRED (plan.ts:42–43). Only an *active free* subscription reaches the PLAN_LIMIT_REACHED branch — this matters for test 334's setup. Other user's portfolio → 403 FORBIDDEN. Frontend handles 403 client-side via `ProGate` overlay.

Mount in `app.ts` alongside the other top-level routes (NOT nested under `/portfolios`):
```ts
import { analyticsRouter } from './modules/analytics/analytics.controller.js';
// in createApp(), after the existing /prices line:
api.route('/analytics', analyticsRouter);
```

### 1.3 Resource representations — EXACTLY from architecture.txt:640-669 [LOCKED]

**Summary** (architecture.txt:640-652):
```ts
export interface SummaryDTO {
  portfolioId: number;
  allTimePnlPct: number;
  allTimePnlValue: number;
  totalDeposits: number;
  totalWithdrawals: number;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
}
```

**Performance** (architecture.txt:654-661):
```ts
export interface PerformanceDTO {
  portfolioId: number;
  snapshots: Array<{ date: string; value: number }>;
}
```
`date` is YYYY-MM-DD; array ordered ASC by date (chart-friendly, AreaChart consumes points left-to-right).

**Holdings** (architecture.txt:663-669):
```ts
export interface HoldingsDTO {
  portfolioId: number;
  assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
}
```
Sorted by `value` DESC, zero-balance assets filtered out. `value` is USD (number). `portfolioPercentage` is 0-100 (unrounded number — frontend rounds for display).

**Frontend-derived fields you must NOT add**:
- `allTimePnlPositive: boolean` — performance page mock (`performance/+page.ts:32-38`) has it, but `+page.svelte:202-207` shows it's used for CSS class binding. The `+page.ts` will compute it from `allTimePnlValue >= 0` once wired. Do not add to SummaryDTO.
- Per-token `d1/d7/d30` on the daily performance table — not in any architecture rep; see §1.11.

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
  
  const [pnl7d, pnl7dValue] = computePnlPeriod(todayValue, snap7d ? Number(snap7d.value.toString()) : null);
  const [pnl30d, pnl30dValue] = computePnlPeriod(todayValue, snap30d ? Number(snap30d.value.toString()) : null);
  
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

`findSnapshotNearDaysAgo` and `getDepositWithdrawalTotals` are new helpers (§1.7).

### 1.5 Performance endpoint logic [LOCKED]

```ts
async function buildPerformance(portfolioId: number): Promise<PerformanceDTO> {
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

No pagination, no query params. Full timeseries returned. At max retention (730 daily snapshots), payload is ~15-30KB JSON — well within reasonable. Frontend downsamples for display.

### 1.6 Holdings endpoint logic [LOCKED]

```ts
async function buildHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  const assets = await findAllAssetsByPortfolioId(portfolio.id);
  const totalValue = computeTotalValue(assets);  // existing assets.dto.ts helper
  
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

Uses `findAllAssetsByPortfolioId` (existing in `src/modules/assets/assets.repository.ts`) and `computeTotalValue` (existing in `src/modules/assets/assets.dto.ts:53-59`). No new helpers needed for this endpoint.

### 1.7 New helpers in their owning modules [LOCKED — module isolation per architecture line 1262-1263]

**Add to `src/modules/snapshots/snapshots.repository.ts`** (raw Prisma queries):
```ts
/** retrofit/Stage 14: most recent snapshot at or before `today - daysAgo`. */
export async function findSnapshotAtOrBefore(
  portfolioId: number,
  cutoffDate: Date,
): Promise<{ value: Prisma.Decimal } | null> {
  return prisma.balanceSnapshot.findFirst({
    where: { portfolioId, snapshotDate: { lte: cutoffDate } },
    orderBy: { snapshotDate: 'desc' },
    select: { value: true },
  });
}

/** retrofit/Stage 14: all snapshots ASC by date — for the performance chart. */
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

**Add to `src/modules/snapshots/snapshots.service.ts`** (wraps the repo helper with date math; Stage 14 calls THIS):
```ts
/**
 * Returns the most recent snapshot at or before `today - daysAgo`. Used by
 * Stage 14 analytics summary for pnl7d / pnl30d. Returns null if no snapshot
 * exists in that window (new portfolio, gap in retention, etc.) — caller treats
 * null as "no historical comparison available" and returns 0 for both fields.
 *
 * The snapshot column is `@db.Date` so PostgreSQL stores midnight-UTC. We
 * construct the cutoff at UTC midnight too — never use local-time arithmetic.
 */
export async function findSnapshotNearDaysAgo(
  portfolioId: number,
  daysAgo: number,
): Promise<{ value: Prisma.Decimal } | null> {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const today = new Date(`${todayYmd}T00:00:00.000Z`);
  const cutoff = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return findSnapshotAtOrBefore(portfolioId, cutoff);
}

/** Re-export the repository helper as a service-layer call (consistency). */
export { findAllSnapshotsAscByPortfolio } from './snapshots.repository.js';
```

**Add to `src/modules/transactions/transactions.service.ts`** (new helper alongside existing exports):
```ts
/**
 * Returns total USD deposits (sum of buy usdValue across native + erc20) and
 * total USD withdrawals (sum of sell). NFT transactions don't contribute.
 * Used by Stage 14 analytics summary endpoint.
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

`Prisma` namespace already imported in transactions.service.ts (line 1: `import { Prisma } from '@prisma/client'`). Verify.

### 1.8 Cache: three keys per portfolio, 5-min TTL each [LOCKED]

Keys:
- `analytics_summary:<portfolioId>`
- `analytics_performance:<portfolioId>`
- `analytics_holdings:<portfolioId>`

Each endpoint wraps its `build*` call in a `withCache` helper, mirroring derive.ts's GET/parse/return-or-recompute pattern:

```ts
// In analytics.service.ts:
const CACHE_TTL_S = 300;

async function withCache<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // fall through
    }
  }
  const result = await compute();
  await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_S).catch((e: Error) =>
    console.error(`[analytics] cache set failed for ${key}:`, e.message),
  );
  return result;
}
```

### 1.9 Cache invalidation via shared helper [LOCKED]

Create `src/lib/portfolio-cache-keys.ts`:
```ts
// Single source for every derived-cache key associated with a portfolio.
// Used by transactions.service.invalidatePnlCache (retrofit-2) and the
// snapshot job's per-upsert hook (retrofit-3), plus tests/helpers.ts truncate.
// Stage 14 adds the three analytics keys; future derived caches add here too.
export function portfolioDerivedCacheKeys(portfolioId: number): string[] {
  return [
    `portfolio_pnl:${portfolioId}`,
    `analytics_summary:${portfolioId}`,
    `analytics_performance:${portfolioId}`,
    `analytics_holdings:${portfolioId}`,
  ];
}
```

**Refactor `src/modules/transactions/transactions.service.ts:30-45`**: replace the inline single-key del with:
```ts
import { portfolioDerivedCacheKeys } from '../../lib/portfolio-cache-keys.js';
// ...
async function invalidatePnlCache(portfolioId: number): Promise<void> {
  const keys = portfolioDerivedCacheKeys(portfolioId);
  await redis.del(...keys).catch((e: Error) =>
    console.error(`[transactions] cache invalidation failed for portfolio ${portfolioId}:`, e.message),
  );
}
```

ioredis accepts variadic args for `del`. If you prefer the array form (`redis.del(keys)`), that also works.

**Refactor `src/jobs/snapshot.job.ts:114-121`** the same way:
```ts
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';
// ... inside the per-upsert success block:
const keys = portfolioDerivedCacheKeys(portfolio.id);
await redis.del(...keys).catch((e: Error) =>
  console.error(`[snapshots] cache invalidation failed for portfolio ${portfolio.id}:`, e.message),
);
```

### 1.10 Test helper extension [LOCKED]

Update `tests/helpers.ts:61-69` (after retrofit-3's portfolio_pnl flush):
```ts
export async function truncateAllUserData(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE
    "payment", "subscription", "transaction",
    "nft", "asset", "portfolio",
    "session", "user"
    CASCADE`;
  // Flush all derived-PnL/analytics caches (TRUNCATE resets portfolio ids,
  // so test B reading portfolio #1 must not get test A's stale cache).
  const derivedKeys = (await Promise.all([
    redis.keys('portfolio_pnl:*'),
    redis.keys('analytics_summary:*'),
    redis.keys('analytics_performance:*'),
    redis.keys('analytics_holdings:*'),
  ])).flat();
  if (derivedKeys.length > 0) await redis.del(derivedKeys);
}
```

### 1.11 MVP gap noted, not addressed [DOCUMENTED]

The Performance page's `dailyPerformance` table (`performance/+page.svelte:82-128` mock) shows per-token `d1/d7/d30` price changes for 5 tokens. **No architecture-defined source for 7d/30d per-token prices** — we don't snapshot `Token.currentPrice` over time.

- 24h column: when wired, comes from the WS price feed (`change24h` on `priceChanges` store, populated by `lib/ws.ts:60-65`). NOT an analytics endpoint.
- 7d/30d per-token: would require Token-table historicals (schema work, post-MVP).

**Stage 14 does not address this**. Frontend will either hide those columns in real-data mode or fill with mocks. If Idowu wants this for MVP, it's a separate scoped retrofit (add `token_snapshot` table + daily token-price snapshot job + per-token historical query). Flag and move on.

## 2. Module scope

```
src/modules/analytics/analytics.dto.ts                    # NEW — 3 DTOs
src/modules/analytics/analytics.service.ts                # NEW — buildSummary, buildPerformance, buildHoldings + withCache
src/modules/analytics/analytics.controller.ts             # NEW — 3 endpoints + middleware chain
src/app.ts                                                # EDIT — mount /analytics router
src/lib/portfolio-cache-keys.ts                           # NEW — shared cache key list
src/modules/snapshots/snapshots.repository.ts             # EDIT — add findSnapshotAtOrBefore + findAllSnapshotsAscByPortfolio
src/modules/snapshots/snapshots.service.ts                # EDIT — add findSnapshotNearDaysAgo + re-export findAllSnapshotsAscByPortfolio
src/modules/transactions/transactions.service.ts          # EDIT — add getDepositWithdrawalTotals + refactor invalidatePnlCache
src/jobs/snapshot.job.ts                                  # EDIT — refactor per-upsert hook to use portfolioDerivedCacheKeys
tests/helpers.ts                                          # EDIT — extend truncateAllUserData with analytics key patterns
tests/analytics.test.ts                                   # NEW — endpoint + cache tests
```

No schema delta. No migration. No new env vars.

## 3. Tests (Vitest, integration — new file `tests/analytics.test.ts`)

Mirror the setup pattern from `tests/snapshots-api.test.ts` (retrofit-3): register/login a user, seed a Pro subscription directly, seed portfolio + assets + snapshots + transactions via prisma, then exercise the endpoint via `app.request`.

Test numbering continues from 325. Target 12 new tests.

326. **`GET /summary` happy path**: portfolio with 1 BTC asset at 93000 (totalValue=93000), netDeposit=80000, transactions: 1 buy native BTC for $80000 USD, 1 sell native BTC for $5000 USD, snapshot 7d ago value=85000, snapshot 30d ago value=70000. Expect:
- `allTimePnlValue ≈ 13000` (93000 − 80000)
- `allTimePnlPct ≈ 16.25` ((13000/80000) × 100)
- `totalDeposits = 80000`
- `totalWithdrawals = 5000`
- `pnl7dValue ≈ 8000` (93000 − 85000)
- `pnl7d ≈ 9.41` ((8000/85000) × 100)
- `pnl30dValue ≈ 23000` (93000 − 70000)
- `pnl30d ≈ 32.86` ((23000/70000) × 100)
Verify the response has exactly the 9 SummaryDTO keys.

327. **`GET /summary` with no historical snapshots** → all four pnl7d/pnl7dValue/pnl30d/pnl30dValue fields = 0. allTime fields still populate from current state.

328. **`GET /summary` with netDeposit=0** → `allTimePnlPct = 0` (divide-by-zero guard in derive.ts). `allTimePnlValue` equals current totalValue.

329. **`GET /performance` happy path**: 3 snapshots seeded across 3 dates → 200 with `data.snapshots` ASC by date, each `{ date: "YYYY-MM-DD", value: number }`.

330. **`GET /performance` on portfolio with no snapshots** → 200 with empty `data.snapshots: []`.

331. **`GET /holdings` happy path**: 2 assets (BTC balance 1.0 at $93000, ETH balance 2.0 at $3200) → 200; assets sorted by value DESC (BTC first), portfolioPercentage approx 93.55 / 6.45. Verify exactly `{ symbol, value, portfolioPercentage }` per item.

332. **`GET /holdings` filters zero-balance assets**: Seed BTC=1.0, ETH balance=0 → response contains only BTC.

333. **`GET /holdings` on empty portfolio** → 200 with empty `data.assets: []`.

334. **All 3 endpoints as Free user** → 403 PLAN_LIMIT_REACHED. (Three separate assertions or one parametrized loop.) **Setup:** seed this user an *active free* subscription (status `active`, plan `free`) — mirror the snapshots/nfts free-gate test setup. Per plan.ts:31–43, a user with NO subscription returns SUBSCRIPTION_REQUIRED and an inactive one returns SUBSCRIPTION_EXPIRED; neither is PLAN_LIMIT_REACHED. If you see SUBSCRIPTION_REQUIRED here, seed the free subscription — do NOT loosen the assertion to match.

335. **All 3 endpoints on another user's portfolio** → 403 FORBIDDEN.

336. **Cache hit on `/summary`**: pre-populate `analytics_summary:<id>` with a sentinel JSON containing recognizable values (e.g. allTimePnlValue=99999); GET returns the sentinel without recomputing. Mirrors retrofit-3 test 321.

337. **Cache invalidation end-to-end**: GET `/summary` (populates cache) → POST a manual transaction → assert `redis.exists('analytics_summary:<id>')` returns 0. This proves the `portfolioDerivedCacheKeys` extension wires correctly through the transactions service hook.

Final test count target: 325 + 12 = 337.

### Updating existing tests

Two test files may need small adjustments because the cache-invalidation set expanded:

- `tests/transactions.test.ts` test 310 (retrofit-2): asserts `redis.del` called with `portfolio_pnl:<id>`. After refactor, `redis.del` is called with `...portfolioDerivedCacheKeys(id)` (4 keys). Update the assertion to check `redis.del` was called WITH portfolio_pnl in its args (use `expect.arrayContaining` or check the variadic). Don't loosen to "called at least once" — that loses signal.
- `tests/snapshots.test.ts` test 325 (retrofit-3): same pattern — currently asserts `redis.del` called with `portfolio_pnl:<id>` per portfolio. Update to match the new variadic call.

If anything else breaks, surface and adjust assertions; don't paper over.

## 4. STOP-AND-ASK gates

1. **If `transactions.service.ts` doesn't already import `Prisma` namespace** — it does (line 1, `import { Prisma } from '@prisma/client'`), verify before adding `getDepositWithdrawalTotals`. If missing, add to the import.
2. **If the snapshot near-date returns the wrong day under timezone edge cases**, the fix is UTC-only arithmetic (§1.7 helper builds cutoff via `new Date('YYYY-MM-DDT00:00:00.000Z')` math). Local-time `setDate` calls drift.
3. **If `redis.del(...keys)` spread doesn't compile cleanly** under ioredis types, use the array form: `redis.del(keys)`. Both are valid ioredis calls.
4. **If existing tests 310 and 325 break** in ways NOT covered by the assertion update above (e.g. spy semantics changed), surface — don't back out the cache key refactor.
5. **If `findAllSnapshotsAscByPortfolio` re-export from service.ts causes a circular import** or shadowing complaint, declare a thin wrapper in service instead of re-exporting directly.
6. **If `getDepositWithdrawalTotals` aggregates are noticeably slow** under a thousand+ transactions, surface — indexing options would be a separate retrofit.

## 5. What NOT to do

- **No edits to `_claude/stage-14.md` or `_claude/stage-14-v2.md`** — leave untracked, exclude from staging.
- **No edits to derive.ts**. computeDerived already returns what summary needs.
- **No schema delta**.
- **No new query params** on any endpoint (no `?period=`, no `?range=`).
- **No edits to `assets.dto.ts`** beyond importing existing helpers — reuse `computeTotalValue`.
- **No per-token daily performance backend support** — §1.11 MVP gap.
- **No editing docx files** — doc-fix items go in report.
- **No `npm audit fix`**.

## 6. Commit and report

Stage explicitly (mirrors retrofit-1/2/3 discipline — no `git add -A`, leave stale stage-14.md/stage-14-v2.md untracked):

```bash
git add src/modules/analytics/analytics.dto.ts \
        src/modules/analytics/analytics.service.ts \
        src/modules/analytics/analytics.controller.ts \
        src/app.ts \
        src/lib/portfolio-cache-keys.ts \
        src/modules/snapshots/snapshots.repository.ts \
        src/modules/snapshots/snapshots.service.ts \
        src/modules/transactions/transactions.service.ts \
        src/jobs/snapshot.job.ts \
        tests/helpers.ts \
        tests/analytics.test.ts \
        tests/transactions.test.ts \
        tests/snapshots.test.ts \
        _claude/stage-14-v3.md
git commit -m "feat(analytics): Stage 14 — GET /analytics/:id/{summary,performance,holdings} + cache + cross-module reads"
git log --oneline -5
```

(`tests/transactions.test.ts` and `tests/snapshots.test.ts` are in the stage list defensively for the test-310/325 assertion updates.)

Report:
- New commit SHA.
- Three integration-test demonstrations (no live server needed, same pattern as retrofit-3):
  - `/summary` showing all 9 fields populated with correct values
  - `/performance` showing snapshots array ASC by date
  - `/holdings` showing assets DESC by value
- Confirmation cache keys appear in Redis after first request, disappear after POST transaction (tests 336 + 337).
- grep proof that every CUD hook (`transactions.service.invalidatePnlCache` and `snapshot.job.ts` per-upsert) uses `portfolioDerivedCacheKeys` — single source confirmed.
- Vitest output: all tests passing (count expected 337: 325 baseline + 12 new).
- Doc-fix pile items added in Stage 14:
  - `Neonfi System Architecture.docx` (optional): analytics endpoints now real; reps match.
  - MVP gap flag: per-token 7d/30d historical prices not addressed (§1.11) — needs a Token snapshot retrofit if Idowu wants it for MVP.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
