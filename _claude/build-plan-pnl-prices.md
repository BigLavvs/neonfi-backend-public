# Build plan — PnL rebuild + prices everywhere + formatting (bundle index)

Sequenced so backend contracts land before the frontend that consumes them. "CC" = run the retrofit in Claude Code (backend). "FE" = Idowu/Claude edits the frontend directly.

## Order & dependencies

1. **retrofit-26 (CC)** — payment history (Basil `invoice.payment_intent`). Independent; run anytime. Then resend `evt_1Tj3n4Ak1U3AIcxNXQmOBZeZ`.

2. **retrofit-27 (CC)** — average-cost PnL + opening balances + auto-add-asset-on-buy. **Defines the new DTO fields** the frontend needs (`avgCost`, `costBasis`, `unrealizedPnl{Value,Pct}`, `realizedPnlValue`, `allTimePnlValue`, `costTracked`). Run before FE steps 4-5.

3. **FE-A (independent — start now, no backend dep):**
   - 8-figure formatter in `src/lib/format.ts`: prices = up to 8 significant figures (trim trailing zeros, 2dp floor ≥ $1); market cap = compact (T/B/M); portfolio totals = grouped 2dp. Apply across all price displays.
   - Live prices everywhere (raw surfaces): `$prices` overlay + `subscribeSymbols()` on token-detail header, Add-Asset & Add-Transaction pickers, Top Movers, any price cell. (wallet + `ws.ts subscribeSymbols` + tx-modal toast auto-dismiss already applied.)

4. **FE-B (after retrofit-27):**
   - "Add Asset" → **"Choose starting assets"**: picker excludes tokens already in the portfolio; cost options (avg / price-on-date / don't track); immutable confirm gate ("can't edit later"); a "your starting assets" section with delete (reuses DeleteAsset; warns if trades exist). Manual portfolios only.
   - Onboarding: reframe the asset step as starting assets.
   - PnL display: realized/unrealized + per-asset PnL on wallet/dashboard/performance; live-overlay the computed aggregates (recompute from `$prices` consistent with the new fields).

5. **Commit (FE):** one `npm run check`, then named-file commits per logical chunk.

## Still open (separate)
- Token cap on Pro — awaiting Idowu's check: Buy picker search "AVAX" (rank 11) → appears = catalog full (fine); "No tokens found" = API still sees free, chase `getEffectivePlan`.

## Already applied locally (uncommitted), folding into FE-A commit
- `ws.ts` `subscribeSymbols` + wallet subscribe; AddTransactionModal submit-error auto-dismiss (4s).
