# retrofit-85 — Accurate connected historical value (H11 deep) — supersedes the estimated marking

The connected value-history backfill values past holdings at **~today's prices** (sync.ts: "older
values are APPROXIMATE — historical balance × ~today's price"). That's the inflated early history
(the $223→$12 "cliff") that retrofit-81 restored to the timeline and retrofit-82 (frontend) marks as
a dashed "estimated" segment. This retrofit replaces the estimate with REAL historical value so the
line is accurate — at which point the dashed marking naturally goes away (those points become
`approx=false`).

## ⚠️ Get this from the PROVIDER — do NOT reconstruct from our transactions
We deliberately do NOT rebuild history from our own transaction set. Our connected transfer import is
**windowed** (recent only), and reconstructing balances/value would need EVERY transfer all-time —
the exact incomplete-data problem that made us use the provider's PnL for all-time (retrofit-79/83)
instead of a DIY net-out. Same rule here: the provider indexes the full chain; we read accurate
history from it, we don't recompute it from data we don't fully have.

**Scope: CONNECTED wallets only.** Manual portfolios are unaffected — they already reconstruct
accurate history from the user's OWN logged transactions + opening cost (retrofit-45/46 + the
frontend `buildAggregateValueSeries` manual path); they have the complete set by definition and no
approximate backfill.

## The fix (provider-sourced, in priority)
1. **Provider historical portfolio value (best).** GoldRush/Covalent exposes a historical
   portfolio-value endpoint (`portfolio_v2` — daily holdings value over a window, valued at
   HISTORICAL prices on their side). Moralis has wallet net-worth (confirm if a historical/by-date
   variant exists). PROBE each (§0): the exact endpoint, the max look-back window, and whether the
   value is historically-priced. If available → write those daily USD values straight into
   `balance_snapshot` as `approx=false`. No pricing math, no balance reconstruction on our side.
2. **Fallback — provider historical BALANCES × our historical PRICES.** If a provider gives
   historical token *balances* (e.g. balance-at-block) but not a priced value, multiply by our
   historical prices: `token_price_snapshot` (retrofit-42, already backfilled) → CoinGecko
   `/coins/{id}/market_chart`. Balances still come from the provider, never from our transactions.
3. **Last resort — keep approximate + marked.** Tokens/days a provider can't cover stay `approx=true`
   so retrofit-82's dashed segment shrinks to only the genuinely-unknowable parts (not the whole
   early history).

## §0 — probe first (gate)
Confirm what each provider actually returns for wallet history and the window length (Covalent
portfolio_v2 historically defaults to a limited window; multi-year may need a paid tier or block
sampling). The probe result decides path 1 vs 2 vs 3 — don't build before confirming the data exists.

## Cost / realism
- This is provider-API-heavy (a multi-year daily series is a lot of data) and the window may be
  capped — hence path 3's graceful fallback. Cache hard; rebuild only on resync.
- It does NOT touch all-time PnL (cost-basis/realized from retrofit-79) — purely the value-over-time chart.

## Interaction with prior work
- `approx` flag stays the source of truth; this just flips far more points to `approx=false`. Both the
  short-term baselines (retrofit-77/78) and the chart marking (retrofit-82) benefit automatically —
  no frontend change needed (the dashed segment shrinks on its own).

## Validate
- A connected wallet's value chart matches reality (no inflated cliff): spot-check days against the
  provider's reported historical value.
- Provider-covered days → `approx=false` (solid); uncovered days/tokens → `approx=true` (still dashed).
- snapshots / wallet-data suites green; mock the provider history endpoint.

## Recommendation
Lower priority than H13 (retrofit-84) — the timeline is already present and honestly marked
(retrofit-81 + 82), so this is an accuracy upgrade, not a correctness gap. And it's gated on the §0
probe: if no provider offers affordable multi-year historical value, the honest dashed-estimate
(retrofit-82) is the right resting state and 85 may not be worth building.
