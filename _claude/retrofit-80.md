# retrofit-80 — Fix the all-time PnL % once it includes realized gains (retrofit-79 regression)

Found in the live audit of retrofit-79 (backend running, Portfolio 2 / id 17, demo wallet). §1's
cost-basis VALUE is right, but the all-time **percent** and the **aggregate** are now broken — they
produce impossible, self-contradictory numbers on the dashboard. This is a "must not mislead"
regression and should land before retrofit-79 is considered done.

## Symptom (live, confirmed)
Portfolio 2 (connected), overview row + analytics summary:
- all-time **value = +$1,391.16**  (unrealized −$139.81 + realized +$1,530.96 — correct)
- all-time **percent = −99.72%**    ✗ positive gain, negative percent — contradictory
Dashboard **headline** (totals):
- all-time **value = +$1,391.16**, **percent = −101.19%**  ✗ impossible >100% loss, also sign-contradicts the value

(The rest of §79 checks out live: 24h +$0.12 real; 7d/30d null→"—"; deposits/withdrawals null;
totalInvested $140.20 + realizedPnl $1,530.96 present; tx count 421 from the provider total.)

## Root cause
Two related defects, both from mixing **realized** PnL into all-time without a lifetime cost base:

1. **Per-portfolio % ignores realized.** derive.ts (§1c) sets, for connected:
   `pnlAllTimeValue = allTimePnlValue` (unrealized + realized = +1391.16) but
   `pnlAllTime = unrealizedPnlPct` (unrealized / costBasisTotal = −139.81 / 140.20 = −99.72%).
   The value includes realized; the percent doesn't → the sign mismatch.

2. **Aggregate base goes negative.** overview.service computes the all-time % over an implied base
   `costBasisAll = allTimeBaseValueNow − pnlAllTimeValue` = (12.34 + 4) − 1391.16 = **−1374.82**, so
   `1391.16 / −1374.82 = −101.19%`. The `value − pnl = base` identity only holds for *unrealized*
   PnL (where the gain is still IN the current value). Realized proceeds have LEFT the wallet, so
   subtracting all-time from current value yields a negative, meaningless base.

The deeper truth: a correct all-time **%** needs the **lifetime cost basis** (total invested to
produce BOTH the realized and the still-held units). We currently have only the *current* holdings'
cost basis ($140.20) and the realized PnL ($1,530.96) — not the cost of the sold units — so the %
is uncomputable from what we store today.

## Fix
Make the percent honest and sign-consistent; never show a % we can't compute correctly.

### Preferred — get the lifetime cost base from the provider (probe first)
The retrofit-79 §0 probe only selected `cost_basis / pnl_realized_usd / pnl_unrealized_usd`. Re-probe
`UpnlWalletItem` for a **total-invested / total-bought** field (e.g. `total_bought_usd`,
`total_invested`, or sold-side fields that let us derive cost-of-sold). If present:
- per token: `lifetimeInvested = total_bought_usd` (or `costBasisHeld + costOfSold`).
- per portfolio: `pnlAllTime = allTimePnlValue / Σ lifetimeInvested × 100` — correct, sign-consistent.
- aggregate: base = `Σ lifetimeInvested` across portfolios (NOT `currentValue − pnl`).
Store `lifetimeInvested` alongside the cost basis in §1 so derive/overview can use it.

### Fallback — if no lifetime-invested field exists
Show the all-time **value** and set the **percent to null → "—"** for connected (and for any
portfolio whose all-time includes realized without a known base). An honest "$+1,391 / —" beats a
fabricated "−99.72%". Concretely:
- derive.ts: for connected, `pnlAllTime = null` unless a valid lifetime base exists (then the real %).
- overview aggregate: compute `pnlAllTime` only over portfolios with a known base; if the connected
  portfolios in scope have no base, the headline all-time % is `null` ("—"), value still shown.
  NEVER use `currentValue − pnlAllTimeValue` as the base.

### Guards (regardless of path)
- The all-time % sign MUST match the value sign (assert in a test).
- A long-only portfolio's all-time % can never be < −100% (you can't lose more than invested);
  treat a computed value past that as a base error → "—".

## Also worth deciding (not a bug — labeling)
"All-time PnL +$1,391" on a wallet currently worth $12 is correct (lifetime realized + current
unrealized) but reads oddly next to the $12 balance. Consider labeling the connected all-time as
"Realized + unrealized (lifetime)" or splitting realized vs unrealized in the UI. Frontend; decide
separately.

## Validate
- Portfolio 2: all-time value +$1,391.16 with a **+** percent (if a base is available) OR "—" (fallback);
  never +value / −percent.
- Headline all-time: sign-consistent; never < −100%; "—" when no base.
- A connected portfolio with net-negative lifetime PnL shows a negative value AND negative %.
- overview + analytics suites green; add: (a) connected all-time value>0 ⇒ pct≥0 or null;
  (b) aggregate never divides by a negative base; (c) the §0 re-probe result drives which path ships.
