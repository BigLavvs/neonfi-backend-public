# retrofit-69 — All-time PnL: show the value-vs-baseline number (C1) + count openings in netDeposit (R39)

**Audit refs:** C1, C1b, R40, M12 (headline shows ~0/green on a −95% portfolio); R39 (manual USDT-only
portfolio shows +33%).

## Problem
- Connected portfolios deliberately set `unrealizedPnlValue = realizedPnlValue = 0` (no cost basis), so
  `allTimePnlValue = unrealized + realized = 0` (`derive.ts:144`, `overview.service.ts:271`). The UI binds
  `allTimePnlValue`, so the all-time headline is 0 → painted green by live-price noise — while the real
  value-vs-baseline `pnlAllTimeValue` (−$293) is computed and ignored.
- Manual all-time uses `pnlAllTimeValue = totalValue − netDeposit` (`derive.ts:138`). Opening positions
  (Starting Assets) are NOT added to `Portfolio.netDeposit`, so a USDT-only portfolio reads value $4 vs
  netDeposit $3 → fake +$1 / +33%.

## Frontend (Cowork — DONE)
Dashboard + Performance now display `pnlAllTimeValue` / `pnlAllTime` and recompute the live % over the
**all-time baseline** (`snapshotTotal − pnlAllTimeValue`), not the zero cost basis. Per-portfolio rows too.
So once the backend half below lands, both connected and manual show honest all-time PnL.

## Backend (R39 — count openings in netDeposit)
When an **opening position** is created/updated/deleted (`assets.service.ts` addAsset / updateAsset /
deleteAsset — the retrofit-27 opening flow), adjust `Portfolio.netDeposit` by the opening's cost basis
(`balance × avgCost`, or the historical-price cost when mode='historical'; mode='none' contributes 0 and
should then be excluded from the cost-tracked basis, not treated as free profit). This makes
`pnlAllTimeValue = totalValue − netDeposit` honest for manual portfolios (a stablecoin opening nets ~0
PnL instead of +33%).

Verify the three opening mutations keep `netDeposit` consistent (create adds, delete subtracts, edit
applies the delta), mirroring how a Buy transaction already adjusts it.

## Validate
- Connected portfolio: `/overview.totals.pnlAllTimeValue` and the dashboard/Performance "All-time PnL"
  now agree (≈ −$293 / −96%), not ~$0.
- Manual USDT-only portfolio with a $1 opening + $3 buy: all-time PnL ≈ $0 (not +$1 / +33%);
  `/analytics/:id/summary.allTimePnlValue`, `/overview`, and Performance agree.
- Overview + analytics suites green; add an assertion that a stablecoin-only manual portfolio reports
  ≈0 all-time PnL after an opening.
