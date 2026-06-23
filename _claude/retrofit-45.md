# retrofit-45 — Transaction-aware reconstructed value history + buy/sell markers

## Why
The portfolio-value chart (`/overview` → `valueHistory`, built by `buildValueHistory` from
`BalanceSnapshot`) is a daily series whose backfilled/intraday history prices **today's** holdings
at past prices — it does NOT reconstruct what the user actually held on each past date. So a past
buy/sell isn't a step in the curve. This retrofit replaces that with a **reconstruction**: value the
*actual holdings as of each date* (opening lots + replayed transactions) at that date's price, and
return per-transaction **markers** (buy/sell, value, and portfolio value right after the tx).

Live PnL/value are already transaction-correct (`recalc.ts` + `derive.ts`); this is purely the
*history* + markers. Out of scope: 24h/7d PnL (leave the existing snapshot-based 24h baseline as-is).

## Data the reconstruction needs (all cross-portfolio, for the user)
1. **Assets** (already fetched as `assetsList` in `buildOverview`): per asset `{ portfolioId, tokenId,
   token.symbol, openingBalance, openingCostBasis, openingAt }`.
2. **All buy/sell tx events** across the user's portfolios — the same shape `recalc.ts` builds, but
   for every portfolio at once. Add a repo query, e.g. `findUserTokenTxEvents(userId)`:
   native + erc20 detail rows joined to `transaction.direction`, filtered to the user's portfolios,
   returning `{ symbol, dir: direction.name, amount:number, ts:Date, portfolioId }`. (NFT excluded;
   `transfer` direction is a no-op for balance — match recalc's rules: only `buy`/`sell` move balance;
   transfer-group legs DO move balance.)
3. **Daily price history** per held token over the range — bulk fetch `token_price_snapshot` for the
   held tokenIds with `snapshotDate >= rangeStart`, into `priceByToken: Map<tokenId, Map<ymd, number>>`.
   Fallback to `Token.currentPrice` when a day has no snapshot. (Add `findTokenPriceSnapshotsSince(tokenIds, sinceDate)` to tokens.repository.ts; mirror the existing single-date helper.)

## Algorithm

### `buildReconstructedValueHistory(assets, events, priceByToken, currentPriceByToken, days): {date,value}[]`
- Aggregate **opening balance per tokenId** = Σ `openingBalance` of assets with that tokenId.
- Build **signed events per tokenId**: `buy → +amount`, `sell → −amount` (transfer direction skipped),
  sorted ascending by `ts` then by tx id.
- Date axis: the last `days` UTC calendar days ending today (one point per day). (Backend already
  clamps `days` to ≤365.) Start no earlier than the first activity date to avoid a flat leading run —
  optional; a flat run is also fine.
- Walk days ascending. For each tokenId keep a running balance pointer that advances through its
  sorted events while `event.ts <= endOf(day)`. Then:
  `value(day) = Σ_token balanceToken(day) × price(token, day)` where `price = priceByToken[token][ymd]`
  on/before `day` (carry the last known snapshot forward), else `currentPriceByToken[token]`.
- Round to 2dp; return `[{ date: 'YYYY-MM-DD', value }]` ascending (same shape the chart already uses).

### `buildTransactionMarkers(assets, events, priceByToken, currentPriceByToken, rangeStart): Marker[]`
For each buy/sell tx event with `ts >= rangeStart`, in ascending order, maintain the same per-token
running balances; **after applying the event**, compute:
`valueAfter = Σ_token balanceToken(now) × price(token, ymd(ts))`
and emit `{ timestamp: ts.toISOString(), direction: dir, symbol, usdValue, valueAfter: round(...) }`.
`usdValue` is the event's USD value (from the detail row). (Transfers: include or skip — recommend
**skip** transfer-group legs in markers since they net to zero across portfolios; keep it simple and
exclude `transferGroupId != null` here.) Cap markers to a sane max (e.g. 500) newest-first if huge.

> Both builders share the per-token running-balance walk — factor a small helper that yields, for a
> sorted event list, the cumulative signed balance at an arbitrary cutoff. Keep it O(events + days).

## Wire into `buildOverview` (overview.service.ts)
- Fetch the new tx events + bulk price snapshots (in the existing `Promise.all`).
- Replace `const valueHistory = buildValueHistory(snapshotsList, days);` with
  `buildReconstructedValueHistory(...)`. (You can delete `buildValueHistory` + the now-unused
  `snapshotsList`/`findAllSnapshotsAscByPortfolio` IF nothing else uses them — check first; the 24h
  baseline uses `findSnapshotNearDaysAgo`, which stays.)
- Add `markers` to the returned aggregate.

## DTO (overview.dto.ts / wherever the /overview response is shaped)
Add:
```ts
markers: Array<{ timestamp: string; direction: string; symbol: string; usdValue: number; valueAfter: number }>;
```
Keep `valueHistory` exactly the same `{date,value}[]` shape (now reconstructed) so the chart needs no
change for the series.

## Tests (mock prices/snapshots; DB harness as existing overview tests)
- A portfolio with an opening lot + one buy a few days later + one sell later: `valueHistory` steps up
  on the buy day and down on the sell day (not a smooth current-holdings-backwards curve).
- `markers` has one entry per buy/sell with correct `direction`/`usdValue` and `valueAfter` equal to
  Σ(reconstructed balance × that-day price) right after the tx.
- A token with no snapshot on a day falls back to `currentPrice`.
- Transfer-group legs are excluded from markers and net-zero in the series.
- `tsc --noEmit` clean; suite green; `NODE_ENV=test`; dev stopped.

## Commit & run
Commit named files only (overview.service.ts, overview.dto.ts, tokens.repository.ts + the new tx-events
repo fn, tests). Report SHA. No migration. Leave dev stopped.

## After it lands
`/overview` returns an accurate, transaction-stepped `valueHistory` plus `markers[]`. The frontend
(separate change) renders green/red dots at each marker with a tooltip (type, value, value-after), and
the daily charts (1W/1M/1Y/ALL) become genuinely transaction-aware. Precision note: prices are daily
beyond the last ~24h, so intraday marker placement is exact only within the retrofit-43 buffer window;
older markers snap to their day.
