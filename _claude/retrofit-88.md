# retrofit-88 — PnL field consistency + duplicate-wallet aggregation

Two issues surfaced by a live 4-portfolio audit (2 manual + 2 connected, built via the CSV importer).
Neither breaks the displayed numbers today, but both are real correctness/consistency gaps.

## Issue 1 — per-portfolio `pnlAllTimeValue` diverges from the displayed all-time P&L
The `/portfolios` summary field `pnlAllTimeValue` is computed as **`totalValue − netDeposit`**, but the
all-time P&L actually DISPLAYED (overview `totals` + the Performance page headline) uses
**`realized + unrealized`** (= `allTimePnlValue`).

These are mathematically identical EXCEPT when a portfolio holds a **cost-unknown ("none" mode)**
asset: `netDeposit` excludes its (unknown) cost, so `value − netDeposit` counts that asset's whole
value as gain, while `realized + unrealized` excludes it (no cost basis to compute from).

Live evidence — P1 held BTC/ETH/SOL (priced) + DOGE (cost-unknown):
- `pnlAllTimeValue` = **$15,818** (value − netDeposit) ; `allTimePnlValue` = **$15,395**
  (realized + unrealized) → diff **$416.30 = exactly DOGE's value**.
- `pnlAllTime` % (36.10%, over netDeposit) vs the displayed 34.8% (over cost basis) likewise differ.

Today the UI reads `realized+unrealized` everywhere it shows P&L, so the `pnlAllTimeValue`/`pnlAllTime`
fields are latent — but they ride on the portfolio summary DTO and WILL mislead the moment any surface
reads them.

**Fix:** make the per-portfolio `pnlAllTimeValue` (and `pnlAllTime` %) use the SAME realized+unrealized
basis the overview + Performance use (i.e. equal to `allTimePnlValue`, % over cost basis), so the field
can never diverge from what's shown. Keep the honest cost-unknown treatment: **exclude** none-cost
assets from P&L — do NOT treat unknown cost as $0 (that overstates gains). Add a test: a manual
portfolio with a none-cost asset → summary `pnlAllTimeValue` === realized+unrealized === the overview's
per-portfolio P&L for it.

## Issue 2 — same wallet connected as two portfolios: value sums, tx count doesn't
Connecting the SAME wallet+chain as two portfolios (audit: P2 & P4, `0xcB1C…59905`): each portfolio's
value is included in the overview total (net worth ~doubles for that wallet), but the overview
transaction count counted the wallet's on-chain total **once** (424, not ~844). So value
double-counts while tx count doesn't — inconsistent, and the doubled net worth is misleading. (P4's
initial sync was also interrupted in the audit, which may compound it.)

It's an unusual user action, but worth handling. **Fix (pick one):**
- **(a, recommended) Disallow/warn** on creating a connected portfolio for a wallet address+chain the
  user already has connected — a clean validation (409 / confirm) that prevents the confusing
  duplicate entirely.
- **(b)** If duplicates stay allowed, make aggregation consistent — dedupe the wallet across
  portfolios for BOTH value and tx count, or count both for both. The value double-count is the
  misleading part.

## Note — Issue from the same audit already fixed on the frontend (no backend change)
The Import-CSV modal previously showed only "N rows failed", not which/why, for server-only rejections
(e.g. a starting-asset row with a historical date the price history doesn't reach). Root cause was the
frontend `api.ts` discarding the 400 body. Fixed FE-side: `ApiError` now carries the response `data`,
and the modal merges `data.errors[]` into the per-row preview. The bulk endpoints already return
`{ error, data: { errors[] } }` on the all_or_nothing 400 — that contract is correct, no change needed.

## Validate
- Manual portfolio w/ a none-cost asset → summary `pnlAllTimeValue` === `realized + unrealized` ===
  the overview's per-portfolio P&L (all three agree).
- Duplicate wallet+chain create → blocked/warned (a) OR value+count aggregate consistently (b).
- Existing `portfolios` / `overview` / `analytics` suites stay green.
