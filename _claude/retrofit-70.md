# retrofit-70 — One price source: value total, allocation & holdings off the SAME live price (C2/C3/M20)

**Audit refs:** C2 (allocation sums $16.62 vs total $16.20), C3 (stale + duplicated daily price; ETH
$1,772.85 vs live $1,698.58), C8 (currentPrice ≠ daily snapshot), M20 (net worth flickers across loads).

## Problem
Two price stores drift apart and different code paths read different ones:
- `Token.currentPrice` — refreshed by the CMC catalog sync (`token-sync.job`); can be hours stale.
- live Redis tick `price:<SYMBOL>` — written EX 60 by the resolver (retrofit-16); fresh.

`/overview` values **allocation** and **holdings** off `Token.currentPrice` (stale $1,772 ETH) while
`derive.computeDerived.totalValue` and the wallet/token pages use the live price ($1,698) — so the donut
slices don't sum to the headline, and the dashboard total flips between loads as the WS overlay arrives.
The daily `token_price_snapshot` also copies `Token.currentPrice` (`snapshot.job.ts:178`), so the chart's
right edge inherits the stale value and consecutive days duplicate when CMC didn't refresh.

## Fix
1. **Single valuation price.** In `overview.service.ts` (and `derive.ts`), value every asset from one
   resolver: `livePrice(symbol) = getLivePriceMap()[symbol] ?? Token.currentPrice`. Use it for
   `totalValue`, `allocation[].value`, `holdings`/per-portfolio value, and the 24h/PnL bases — the same
   map, so the donut sums to the total and per-portfolio sums reconcile. (`derive.ts` already references a
   `getLivePriceMap ?? Token.currentPrice` pattern for currentPrice — extend it to allocation/holdings.)
2. **Keep `Token.currentPrice` fresh.** Have the resolver write the canonical live price back to
   `Token.currentPrice` on each tick (or a short-interval flush), so the daily snapshot + any
   currentPrice-based reads aren't hours behind. At minimum, the daily `token_price_snapshot` should read
   the live price, not a stale `Token.currentPrice`, and must NOT write a duplicate when the price is
   unchanged/stale (skip if the live price is missing rather than copying yesterday's).
3. Round allocation so Σ(allocation.value) == totalValue (distribute the rounding remainder, or compute
   percentages from the same values used for the total).

## Validate
- `/overview`: Σ(allocation.value) == totalValue (±$0.01); per connected portfolio, Σ(token values) ==
  portfolio totalValue.
- Dashboard donut ETH % == wallet table ETH % == token-page (after retrofit-71 scoping); ETH valued at
  the live price on every surface.
- Two `/overview` calls seconds apart return the same totalValue (no stale/live flip).
- Overview suite green; add: allocation sum equals total; valuation uses the live map.
