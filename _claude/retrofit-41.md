# retrofit-41 — Backfill snapshot history so the charts render (dev/demo seed)

## Symptom
Every time-series chart is empty at all ranges — dashboard "Portfolio Value" shows *"Not enough
history yet — daily snapshots will populate this chart."*, token-detail price charts and the
performance charts likewise. The donut (current allocation) renders because it uses live state.

## Cause (confirmed in code)
Charts read two snapshot tables, both populated ONLY going-forward by `snapshot.job.ts`:
- `BalanceSnapshot` (portfolio value/day) — written **Pro-only**, once per day.
- `TokenPriceSnapshot` (token price/day) — written for all catalog tokens, once per day.

A fresh/dev DB has none, so there's nothing to plot. The READ paths are NOT plan-gated
(`overview.service.ts` → `findAllSnapshotsAscByPortfolio`; token history → `TokenPriceSnapshot`), so
simply inserting historical rows makes the charts render for any plan.

## Change — one-off idempotent backfill `src/scripts/backfill-snapshots.ts` (`npm run backfill:snapshots`)
Seeds ~365 days of **plausible demo history** (clearly synthetic — see note). Two steps:

### 1. Per-token daily price series (powers token charts + feeds step 2)
For each catalog token, walk BACKWARD from its current `Token.currentPrice` so the series ENDS at
today's real price and drifts plausibly before it:
```ts
const DAYS = 365;
const DAILY_VOL = 0.025; // ~2.5%/day — plausible crypto volatility
// deterministic PRNG seeded per tokenId → re-runs reproduce the same curve (true idempotency,
// not just row-count). e.g. mulberry32(tokenId).
function seriesFor(currentPrice: number, tokenId: number): number[] {
  const rng = mulberry32(tokenId);
  const out = new Array<number>(DAYS);
  out[DAYS - 1] = currentPrice;                       // today = real price
  for (let i = DAYS - 2; i >= 0; i--) {
    const r = (rng() * 2 - 1) * DAILY_VOL;            // ±vol
    out[i] = Math.max(1e-8, out[i + 1] * (1 - r));    // step backward
  }
  return out; // index 0 = oldest day, DAYS-1 = today
}
```
Write `token_price_snapshot` in CHUNKED bulk inserts (mirror snapshot.job's
`INSERT … VALUES … ON CONFLICT ("tokenId","snapshotDate") DO UPDATE SET "price"=EXCLUDED."price"`,
~1000 rows/statement). `snapshotDate` = each day's UTC `::date` (today − i days). Keep the
per-(tokenId,day) price map in memory for step 2.

### 2. Per-portfolio daily value (powers dashboard + performance charts)
For EVERY portfolio (not just Pro — the read isn't gated), value each day from CURRENT holdings ×
that day's seeded price:
```ts
// assets: { tokenId, balance } for the portfolio
for (let i = 0; i < DAYS; i++) {
  const value = assets.reduce((s, a) => s + a.balance * priceByToken.get(a.tokenId)![i], 0);
  // upsert balance_snapshot (portfolioId, userId, value, snapshotDate = today − (DAYS-1-i))
}
```
Bulk insert `balance_snapshot` `ON CONFLICT ("portfolioId","snapshotDate") DO UPDATE SET "value"=EXCLUDED."value"`.
(Simplification: uses current balances for all past days — fine for a demo curve; it does not
reconstruct holdings as of each historical date.)

### 3. Invalidate caches
After writing, `redis.del(...)` the affected `portfolioDerivedCacheKeys(portfolioId)` plus the
`overview:<userId>:*` keys, so the next chart load recomputes from the new history.

## Notes / decisions
- **Synthetic, labelled.** These are demo prices (a seeded random walk that lands on today's real
  price), NOT real historical data — there's no historical price source wired in. Good enough to make
  the charts live; if you want REAL history later, swap step 1 for a CoinGecko `market_chart` fetch
  per token (free, needs symbol→id mapping + rate limiting).
- **Ongoing snapshots are still Pro-gated** in `snapshot.job.ts` (write side). This backfill makes the
  charts render now; for them to keep growing daily on a free demo account, either run the account as
  Pro or relax that gate — separate decision, not in this script.

## Tests
- `tests/...backfill-snapshots`: after running against a seeded portfolio, `token_price_snapshot` has
  DAYS rows per token with the last row == `currentPrice`; `balance_snapshot` has DAYS rows per
  portfolio with each value == Σ(balance × that-day token price); re-running is idempotent (same row
  counts, same values). `tsc --noEmit` clean; suite green, `NODE_ENV=test`, dev stopped.

## Commit & run
Commit named files only (`src/scripts/backfill-snapshots.ts`, `package.json` script, the test). Report
SHA. Then `npm run backfill:snapshots` against the dev DB; paste the summary line
(`{tokenSeries, tokenRows, portfolioRows}`). Leave dev stopped.

## After it lands
Hard-refresh the dashboard: the Portfolio Value chart renders across 1W/1M/1Y/ALL (1H/1D are sparse —
daily granularity), token-detail price charts fill in, and the performance charts populate.
