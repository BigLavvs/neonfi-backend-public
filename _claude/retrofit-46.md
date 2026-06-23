# retrofit-46 — Revert retrofit-45; move value-history reconstruction to the frontend

## Rationale
Holdings are a **step function** — they only change at a transaction. So the backend doesn't need a
day-by-day reconstruction service (retrofit-45). Instead the backend just exposes raw inputs and the
**frontend** computes `value(t) = holdings(t) × price(t)` (+ markers). This reverts retrofit-45 and
adds two small read endpoints the frontend needs.

Pricing rules the frontend will follow (no backend work, just FYI so the contracts fit):
- Holdings between transactions are valued at the **market price at that time** — from the retrofit-43
  buffer for ≤24h, and from daily `TokenPriceSnapshot` (the day's **close**) beyond 24h.
- A transaction's own value/step uses **its recorded price** (`priceAtTime`/`usdValue`), not a lookup.

---

## Part A — Revert retrofit-45
`git revert` the retrofit-45 commit (clean undo), which restores the snapshot-based
`buildValueHistory(snapshotsList, days)` in `overview.service.ts`, drops `markers` from the
`/overview` DTO, and removes `buildReconstructedValueHistory` / `buildTransactionMarkers` /
`findUserTokenTxEvents` / `findBulkTokenPriceSnapshotsSince`. Confirm `tsc` + suite are green after the
revert before Part B. (Report the revert SHA.)

> Note: `findTokenPriceSnapshotsSince` (per-token, pre-existing, used by `GET /tokens/:id/history`)
> stays — only the retrofit-45 additions go.

---

## Part B — Extend `GET /prices/history` to daily ranges
Today it serves `1H`/`1D` from the Redis buffer (retrofit-43). Add daily ranges so the frontend has a
single "price-at-time per symbol" source at **any** range.

### `prices.schemas.ts`
Widen the range enum: `range: z.enum(['1H','1D','1W','1M','1Y','ALL']).default('1H')`.

### `prices.service.ts` → `getPriceHistory(symbols, range)`
- `1H`/`1D` → unchanged (Redis buffer).
- `1W`/`1M`/`1Y`/`ALL` → read **daily** `TokenPriceSnapshot`:
  - Map `symbols` → tokenIds (`prisma.token.findMany({ where: { symbol: { in } }, select: { id, symbol } })`).
  - `RANGE_DAYS = { '1W':7, '1M':30, '1Y':365, 'ALL':365 }` (ALL caps at 365 like the rest); `since = todayUTC − days`.
  - Bulk fetch snapshots `WHERE tokenId IN (...) AND snapshotDate >= since` ordered ASC (re-add a small
    bulk query, or loop the existing `findTokenPriceSnapshotsSince` per token — bulk preferred).
  - Return per **symbol**: `{ [symbol]: Array<{ t:number; p:number }> }` where `t = snapshotDate` epoch ms
    (UTC midnight) and `p = price`. Ascending. Missing symbol → `[]`.
- Keep the response envelope identical: `{ data: { history: { SYM: [{t,p}] } } }`. Auth-required, not
  Pro-gated (same as today).

This makes `/prices/history?symbols=BTC,ETH&range=1Y` return each symbol's daily close series; `range=1H`
still returns the intraday buffer. One endpoint, any range.

---

## Part C — User-level transactions endpoint (for markers + holdings reconstruction)
The frontend needs every transaction for the user (across portfolios) to (a) build the holdings step
function and (b) drop markers. Add a cross-portfolio read:

`GET /overview/transactions?limit=` (auth) → `{ data: { transactions: TransactionListDTO[] } }`, newest
-first, `limit` default 500 / max 2000. Reuse the existing `listRecentUserTransactions(userId, limit)`
(it already returns the flat `TransactionListDTO` with `timestamp`, `direction`, `symbol`, `amount`,
`usdValue`, `priceAtTime`). Mount it next to the existing `/overview` handler.

(If `/overview` is a single handler not a router, either convert to a small router or add a sibling
route `GET /overview/transactions` at the app level — match the codebase's routing style.)

---

## Tests
- `GET /prices/history?range=1Y` returns per-symbol daily series from `TokenPriceSnapshot` (ASC, `{t,p}`);
  `range=1H` still returns the buffer; unknown symbol → `[]`; bad range → 400.
- `GET /overview/transactions` returns the user's transactions (capped, newest-first), behind auth.
- Post-revert: `/overview` no longer returns `markers`; `valueHistory` is the snapshot series again.
- `tsc --noEmit` clean; suite green; `NODE_ENV=test`; dev stopped.

## Commit & run
Commit named files only (prices.schemas.ts, prices.service.ts, prices.controller.ts if a route changes,
the overview transactions route + repo if needed, tests) — plus the revert commit. Report SHAs. No
migration. Leave dev stopped.

## After it lands
Frontend (separate change) will: fetch `/prices/history?symbols=<held>&range=<range>` for any range +
`/overview/transactions`, then reconstruct `value(t)=holdings(t)×price(t)` (holdings = current −
transactions after t), draw green/red markers at each transaction with a tooltip (type, value-at-its-
price, and portfolio value after), across all ranges — unifying the intraday + daily chart paths.
