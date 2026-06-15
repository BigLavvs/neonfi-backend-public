# retrofit-13: GET /api/v1/overview — dashboard aggregate (cross-portfolio)

## Why
The frontend dashboard Overview (`(dashboard)/dashboard/+page.ts`) is an **aggregate
cross-portfolio** view: total value, total PnL (24h + all-time), total tx count, # active
portfolios, a portfolio-value chart, an allocation donut, and recent transactions across
**all** of the user's portfolios. The backend currently exposes only **per-portfolio** data
(`GET /portfolios` list with per-portfolio derived value/PnL, and Pro-only per-portfolio
`/analytics/:id/{summary,performance,holdings}`). There is no aggregate endpoint, so the
dashboard's chart / allocation / recent-tx / tx-count have no single source.

This adds one **plan-agnostic** (free + pro) endpoint that aggregates server-side in a single
round-trip — chosen over client-side N+1 (a 10-portfolio Pro user would otherwise fire ~30
browser requests per dashboard load). Idowu approved the backend-endpoint approach.

> Numbering note: `retrofit-12` is reserved for the deployment CORS / cross-site-cookie work
> (not yet written). This is `retrofit-13`.

## Endpoint
`GET /api/v1/overview` — `requireAuth` only. **Not** Pro-gated (the dashboard Overview, incl.
the value chart and allocation, is shown to free users; only the *PnL breakdown* and the
*Performance* page are Pro-gated, and those stay on the existing analytics endpoints).

Optional query params (both with safe defaults; validate with a small Zod schema like the
other modules):
- `days` — value-history window, default `90`, clamp 1..365.
- `txLimit` — recent-transactions count, default `10`, clamp 1..50.

New module `src/modules/overview/` (composition module like `analytics`, owns no tables):
`overview.controller.ts`, `overview.service.ts`, `overview.dto.ts`. Mount in `src/app.ts`
next to the other routers: `app.route('/api/v1/overview', overviewRouter)`. A dedicated
top-level mount (not under `/portfolios`) deliberately avoids any collision with
`GET /portfolios/:id`.

## Response shape (envelope `ok(data)` → `{ data: OverviewDTO }`)
Design it to map cleanly onto what `dashboard/+page.ts` consumes so the frontend transform is
thin. Round all derived floats to 2dp via the same `round()` convention used in
`analytics.service.ts:38`.

```ts
interface OverviewDTO {
  totals: {
    totalValue: number;          // Σ portfolio.totalValue
    pnl24h: number;              // aggregate %  (see formula below)
    pnl24hValue: number;         // Σ portfolio.pnl24hValue
    pnlAllTime: number;          // aggregate %
    pnlAllTimeValue: number;     // Σ portfolio.pnlAllTimeValue
    portfolioCount: number;
    transactionCount: number;    // across all the user's portfolios
  };
  portfolios: Array<{
    id: number;
    name: string;
    slug: string;
    type: 'connected' | 'manual';
    chainId: number | null;
    chainName: string | null;    // from portfolio.chain.name (PortfolioWithRelations includes chain)
    assetCount: number;          // # assets with balance > 0
    totalValue: number;
    pnl24h: number;
    pnl24hValue: number;
    pnlAllTime: number;
    pnlAllTimeValue: number;
  }>;
  valueHistory: Array<{ date: string; value: number }>;   // 'YYYY-MM-DD', aggregate, asc
  allocation:   Array<{ symbol: string; value: number; percentage: number }>; // desc by value
  holdings:     Array<{ symbol: string; balance: number }>;  // aggregate balance per symbol
  recentTransactions: TransactionListDTO[];               // most recent `txLimit`, desc by timestamp
}
```

Aggregate-percentage formulas (guard divide-by-zero → 0; never NaN/Infinity, mirroring
`analytics.service.ts:computePnlPeriod`):
- `pnlAllTime  = costBasisAll === 0 ? 0 : (pnlAllTimeValue / costBasisAll) * 100`,
  where `costBasisAll = totalValue - pnlAllTimeValue`.
- `pnl24h      = base24 === 0 ? 0 : (pnl24hValue / base24) * 100`,
  where `base24 = totalValue - pnl24hValue`  (i.e. value 24h ago).

## Service — `getOverview(userId, { days, txLimit })`
Compose from existing public surfaces (module-isolation: read other modules through their
service/repo surface exactly as `analytics.service.ts` already does — it imports
`computeDerived`, `findAllSnapshotsAscByPortfolio`, `findAllAssetsByPortfolioId`,
`computeTotalValue`). Steps:

1. **Portfolios.** `findPortfoliosByUserId(userId, { limit: <large>, offset: 0 })`
   (`portfolios.repository.ts` — returns `{ portfolios: PortfolioWithRelations[], total }`;
   `PortfolioWithRelations` includes `type` + `chain`, see `portfolios.dto.ts:5-7`). If the
   user has zero portfolios, short-circuit to an all-empty OverviewDTO (totals all 0, arrays
   empty) and return — do NOT 404.

2. **Per-portfolio derived.** For each portfolio call `computeDerived(p.id)`
   (`portfolios/derive.ts`, already Redis-cached at `portfolio_pnl:<id>`). Gives
   `totalValue, pnl24h, pnl24hValue, pnlAllTime, pnlAllTimeValue` (same fields `PortfolioDTO`
   exposes, see `portfolios.dto.ts:19-27`). Sum the *value* fields for `totals`; recompute the
   aggregate %s with the formulas above.

3. **Assets (allocation + holdings + assetCount).** For each portfolio,
   `findAllAssetsByPortfolioId(p.id)` (`assets.repository.ts`; each asset has
   `token.symbol`, `token.currentPrice`, `balance` — see `analytics.service.ts:116-137`).
   - `assetCount` per portfolio = count of assets with `balance > 0`.
   - Aggregate **allocation** by `token.symbol`: sum `balance * currentPrice` → `value`;
     `percentage = grandTotal === 0 ? 0 : value/grandTotal*100`; sort desc by value; round 2dp.
   - Aggregate **holdings** by symbol: sum `balance` (raw, for the frontend's live-price
     recalc). Keep full precision balance (it's a quantity, not a derived float) but it's fine
     to `Number(balance.toString())`.

4. **Value history (chart).** For each portfolio,
   `findAllSnapshotsAscByPortfolio(p.id)` (`snapshots.service.ts`; rows have `snapshotDate`,
   `value` — see `analytics.service.ts:105-114`). Build the aggregate series:
   - Union of all snapshot dates across portfolios (date = `snapshotDate.toISOString().slice(0,10)`).
   - Sort asc, keep only the last `days` dates.
   - For each kept date, sum each portfolio's **most recent snapshot value on/before that date**
     (forward-fill); a portfolio with no snapshot on/before that date (created later)
     contributes 0. This keeps the total from dipping when a newer portfolio has fewer points.
   - Round each summed value 2dp. If there are no snapshots at all, return `[]`.

5. **Recent transactions + count (cross-portfolio).** Add to `transactions.repository.ts`
   (mirror `listTransactions`/`countTransactions` but filter by owner via the relation):
   ```ts
   // where: { portfolio: { userId } }  — Prisma relation filter
   export async function listRecentTransactionsForUser(userId, limit): Promise<TransactionWithListIncludes[]>
     // findMany: where {portfolio:{userId}}, orderBy {timestamp:'desc'}, take limit, include LIST_INCLUDE
   export async function countTransactionsForUser(userId): Promise<number>
     // count: where {portfolio:{userId}}
   ```
   Expose thin wrappers from `transactions.service.ts` and map rows with the existing
   `toTransactionListDTO` (`transactions.dto.ts:78`). (The frontend maps
   direction/`transferGroupId` → buy/sell/transfer, `usdValue` → value, `timestamp` → date.)

6. **Cache.** Wrap the whole compute in a per-user Redis cache, key `overview:<userId>`,
   TTL 60s (shorter than analytics' 300s since it spans tx writes; full invalidation wiring is
   out of scope — note it as a follow-up). Reuse the GET/parse/recompute + SET-failure-logs
   pattern from `analytics.service.ts:46-60`. Note the cache key must include `days`/`txLimit`
   if you honor those params in the cached payload — simplest is `overview:<userId>:<days>:<txLimit>`.

## Gates (must pass before commit)
Add `tests/overview.test.ts` (per-file run, Neon-retry recipe). Use the existing test
helpers/factories the other suites use (e.g. how `analytics.test.ts` / `portfolios.test.ts`
seed a user + portfolios + assets + snapshots + transactions).
1. **Empty user** (no portfolios) → 200, all totals 0, all arrays `[]` (no 404).
2. **Aggregation** — user with 2 portfolios, assets in each, some overlapping symbols:
   `totals.totalValue` = sum of both; `allocation` merges the shared symbol into one row with
   summed value and correct % (sorted desc); `holdings` merges balances; `assetCount` per
   portfolio correct.
3. **valueHistory** — seed snapshots on differing dates across the two portfolios; assert the
   forward-fill sum is correct on a date where only one portfolio has an earlier snapshot.
4. **recentTransactions / transactionCount** — seed txs in both portfolios; assert the list is
   the most-recent `txLimit` across both (desc by timestamp) and `transactionCount` = total.
5. **Plan-agnostic** — a **free** user (active free sub) gets 200 (NOT 403). Also assert a
   second user cannot see the first user's data (ownership via `where:{portfolio:{userId}}`).
6. **Auth** — no session → 401.
Then run the moralis-webhook signature tests + a couple of unrelated files to confirm no
regression from the new transactions.repository/service exports.

## Commit (explicit add, no -A)
```bash
git add src/modules/overview/ src/modules/transactions/transactions.repository.ts \
        src/modules/transactions/transactions.service.ts src/app.ts \
        tests/overview.test.ts _claude/retrofit-13.md
git commit -m "feat(overview): GET /api/v1/overview dashboard aggregate (retrofit-13)"
```
Leave the stale `_claude/stage-14*.md` / `frontend-audit.md` untracked. Report the SHA + the
overview test results + the full-suite (per-file) status.

## After this lands
I (frontend) will add `ENDPOINTS.overview = '/overview'` and rewire
`(dashboard)/dashboard/+page.ts` to map this DTO → the page's existing
`{ summary, portfolios, chartPoints/Labels, allocation, holdings, recentTransactions }` shape,
then live-test as demo2 once a portfolio exists.
