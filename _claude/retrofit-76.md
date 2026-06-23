# retrofit-76 — Manual portfolios' 24h/7d/30d PnL (keep multi-portfolio aggregates consistent)

## Context: do the calcs hold across multiple portfolios of different types?
Audited each aggregate for N portfolios of mixed types. Holds:
- **totalValue** — Σ per-portfolio (one live price map). ✓
- **transactionCount** (retrofit-74) — Σ connected externalTxCount (deduped by wallet address so the same
  wallet in two portfolios counts once) + manual DB rows. ✓
- **allocation/holdings** — aggregated by symbol across all portfolios off the live map; same token in two
  portfolios sums; Σ(allocation) ≈ totalValue. ✓ (frontend wallet merge also sums balances now.)
- **all-time PnL** (retrofit-75) — canonical per type (connected snapshot-vs-earliest, manual cost-basis),
  summed; aggregate % over the implied base. Per-portfolio rows each honest; blended aggregate is sound. ✓
- **24h phantom** (retrofit-75 M16) — a portfolio with no 24h snapshot is excluded from BOTH sides. ✓

## The one gap (this retrofit)
`derive.ts` computes 24h/7d/30d ONLY for connected portfolios (`computeConnectedDerived`, from
BalanceSnapshot deltas). The MANUAL path **hardcodes pnl24h/7d/30d = 0** (derive.ts:156-161). But the
overview TOTALS 24h (retrofit-75) sums the snapshot delta for EVERY portfolio with a ~24h-old snapshot —
manual included (the daily snapshot job snapshots all Pro portfolios). So once a manual portfolio has ≥1
day of history:
1. **totals 24h ≠ Σ per-portfolio 24h rows** — the manual's change is in the headline, its row shows 0.
2. **manual portfolios never display their own 24h/7d/30d** on the dashboard / per-portfolio rows.

Masked today only because the demo's single manual portfolio has no 24h-ago snapshot yet (so it's excluded
from the totals too, and the numbers happen to line up). It WILL surface as manual portfolios age, and for
any user with multiple manual portfolios.

## Fix
In `derive.ts`, compute 24h/7d/30d for MANUAL portfolios from BalanceSnapshot deltas — exactly like
`computeConnectedDerived` already does: `currentValue − findSnapshotNearDaysAgo(id, N)` with the
retrofit-72 H5 tolerance (no snapshot within tolerance → 0/0). Leave the cost-basis all-time path
unchanged. Extract the delta helper so both the connected and manual paths share it.
- This populates manual per-portfolio short-term PnL AND makes `totals.pnl24hValue === Σ per-portfolio
  pnl24hValue` for ANY mix.
- Architecture note: derive already reads BalanceSnapshot for connected, so the old "snapshots belong to
  analytics" comment on the manual path is superseded — extend the same read to manual.

## Validate
- Manual portfolio with a 24h-ago snapshot → real per-portfolio pnl24hValue (not 0); 7d/30d likewise.
- `totals.pnl24hValue === Σ per-portfolio pnl24hValue` across manual+connected, with/without snapshots.
- Manual portfolio with NO 24h snapshot → 0 and excluded from totals (unchanged).
- overview + analytics + portfolios suites green; add: a manual portfolio with a seeded 24h snapshot
  shows its delta in BOTH its row and the totals (they match).
