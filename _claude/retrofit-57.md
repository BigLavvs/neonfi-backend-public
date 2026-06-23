# retrofit-57 — DIAGNOSTIC: delete + clean-rebuild the connected wallet, with a full sync trace

**Read + a deliberate delete/recreate of the test portfolio. No app-code changes. Temp script; delete it after.**

Goal: delete the broken connected portfolio and rebuild it for `0xcB1C1FdE09f811B294172696404e88E658659905`
(eth), logging **every provider call and the per-token balance reconciliation**, so we can see exactly
where the negative and inflated balances come from. The browser can only see frontend↔backend traffic;
these Moralis/Covalent calls are server-side, which is why this runs in the backend.

## What we already know (confirmed live on Portfolio 2 / id 12)
Three disagreeing "today" values: positive-only sum **$175.76** (dashboard headline) vs `computeDerived`
**$29.61** (all assets incl. negatives = wallet "Net Worth") vs Covalent recorded **$12.27**
(`connectedValueHistory`). Negatives: WBTC −$59.31, USDC −$50.03, CBETH −$21.80, UNI −$15.01 (≈ −$146).
Inflation: ETH 0.0775 ($131, 442%), STETH ($40). `reconcileOpeningLots` only seeds a *positive* residual
(sync.ts:407) and only for currently-held tokens (line 400), so sold tokens go negative and overshooting
held tokens are never trimmed. This script gets the **provider-side truth** to confirm the mechanism.

## Steps (write a temp `scripts/diag-rebuild.ts`, run with tsx, delete after)

### 1. Delete the existing connected portfolio
Find it (type=connected, walletAddress ilike `0xcb1c…905`, or id 12) and delete via the **proper service
path** (`deletePortfolio(userId, id)` — it tears down the Moralis stream and cascades
assets/transactions/nfts/snapshots). Confirm the row is gone.

### 2. BEFORE rebuild — call the providers directly and DUMP the raw responses
Use the wrappers from `wallet-data/index.ts` with `chain = { slug: 'eth' }`:
```
const addr = '0xcB1C1FdE09f811B294172696404e88E658659905';
const chain = { slug: 'eth' };
```
- `fetchWalletSummary(addr, chain)` → print **every held token**: `symbol, balance, usdPrice, usdValue`,
  and the **summed total**. ← this is the provider's ground-truth current net worth. Compare it to
  $28 / $29.61 / $175.76 / $12.27 — this single number tells us which (if any) is real, and whether ETH
  is actually ~0.0775 or far less.
- `fetchTransferPage(addr, chain, { limit: 100 })` → print `transfers.length`, `totalCount`, `nextCursor`,
  and for ETH, UNI, USDC, WBTC, CBETH the **net signed amount within this page** (Σ in − Σ out).
- `fetchTransactionCount(addr, chain)` and `fetchValueHistory(addr, chain, 365)` → print the count, and
  the value-history length + first + last entry.

### 3. Rebuild + run the initial sync
Recreate the connected portfolio for the wallet (eth) via the same create path the app uses, then run
`syncConnectedHoldings(newPortfolioId, addr, chain)`.

### 4. AFTER sync — dump the reconciliation per token
For every `Asset` on the new portfolio, print a row:
`symbol | providerBalance (from step-2 summary, or '—' if not held) | finalBalance (Asset.balance) | price | value`
and FLAG:
- `finalBalance < 0`  → **NEGATIVE** (sold token, no opening seeded)
- `finalBalance > providerBalance + epsilon` → **INFLATED** (overshoot never trimmed)
- `not in provider summary but finalBalance != 0` → orphaned

Then print `computeDerived(newPortfolioId).totalValue`, the **positive-only** sum, and the first/last of
the new `connectedValueHistory` (or BalanceSnapshot).

### 5. Paste all of step 2 and step 4 output back.

## The questions this answers definitively
- Does `fetchWalletSummary` return the wallet's **real** holdings (small ETH, ~$28 net), or already-inflated
  balances? → tells us whether the bug is our reconciliation or the provider data itself.
- Are sold tokens (UNI/USDC/WBTC/CBETH) **absent** from the summary (so no opening is ever seeded → the
  negative survives)? → confirms the held-only reconcile gap.
- Is each final balance equal to the provider balance (correct) or overshooting it (inflation)?

The answers drive the rework (3-yr window + B0 opening for *all* tokens + full in-window import +
single-source reconstruction) we already scoped.

## Out of scope
No app-code changes, no schema, no commit. Pure diagnostic + the requested test-portfolio rebuild.
Remove `scripts/diag-rebuild.ts` afterward.
