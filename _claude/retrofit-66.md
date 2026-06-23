# retrofit-66 — Expose per-portfolio inception date (stop manual charts pre-dating the portfolio)

A just-added **manual** portfolio's value chart draws back ~1 year (to June 2025). Cause: the frontend
reconstructs `currentHoldings × historicalPrice(t)` across the whole window, and a manual opening is an
`Asset.openingBalance` (no date), so there's no signal for when the portfolio actually started — it
extends to the earliest price sample. Fix: expose each portfolio's **inception date**; the frontend
clamps the manual reconstruction to it. (Connected portfolios are unaffected — their `BalanceSnapshot`
history is real on-chain value and legitimately predates the portfolio row.)

## Backend
`src/modules/overview/overview.service.ts` + `overview.dto.ts`:
- For each portfolio, compute `inceptionDate = min(portfolio.createdAt, earliest transaction timestamp)`
  (a backdated logged transaction should let the line start earlier; otherwise it's createdAt). Add a
  repo helper `findEarliestTransactionDate(portfolioId)` (a `MIN(timestamp)` / `findFirst orderBy
  timestamp asc`), or fold it into the existing per-portfolio fan-out in `buildOverview`.
- Add `inceptionDate: string` (ISO) to each entry of `OverviewDTO.portfolios`.
- Manual + connected both get it; the frontend only *uses* it to clamp the manual reconstruction.

## Validate
- A freshly-created manual portfolio (no backdated tx) → `inceptionDate ≈ createdAt` (today).
- A manual portfolio with a transaction backdated to 2024 → `inceptionDate` = that tx's timestamp.
- Overview suite green; add an assertion that `inceptionDate` is present and equals createdAt for a
  fresh portfolio.

## Frontend (Cowork — done alongside)
`intraday.ts buildAggregateValueSeries` clamps the **manual** reconstruction to the earliest
`inceptionDate` among the selected manual portfolios (points before it are dropped); the connected
recorded portion is untouched. Dashboard/performance loaders thread `inceptionDate` through. Defensive:
when `inceptionDate` is absent (pre-this-retrofit), no clamp — graceful.

## Out of scope
Backdated *opening* (Asset.openingBalance) historical dating — openings are "held since creation," so
createdAt is the right floor for them; only logged transactions move inception earlier.
