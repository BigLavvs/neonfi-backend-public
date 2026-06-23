# retrofit-59 — Lock connected balances to the provider (stop recalc from reverting retrofit-58 Part 1)

retrofit-58 Part 1 made a connected `Asset.balance` equal the provider summary (truth). But
`recalcAssetBalance` still **recomputes** balance from the (windowed) transaction set on every
transaction write — and on a connected portfolio that windowed sum is exactly the wrong number Part 1
fixed. Two paths trigger it and silently revert the fix:

- **Load-more** (`importMoreTransfers`) — clicking "Load older transactions" recalcs → balances break
  again immediately.
- **Webhooks** (`createTransactionFromWebhook` → recalc) — now **live**, because retrofit-58 Part 3
  fixed stream creation, so the next on-chain transfer reverts the balance.

Make the **provider the sole source of connected balances** everywhere. This completes Part 1; it does
not touch manual portfolios.

## 1. `recalc` skips connected balances
`src/modules/transactions/recalc.ts` (+ `recalcAssetBalance` in `transactions.service.ts`).
- When the asset's portfolio is **connected**, do NOT recompute/write `Asset.balance` (nor
  `netDeposit`/cost fields — already N/A for connected). Leave them as
  `setConnectedBalancesFromSummary` set them. For **manual**, behave exactly as today.
- recalc will need the portfolio type — fetch it (or pass it through) and branch. Keep it a no-op for
  connected rather than a partial update, so the provider stays authoritative.

## 2. Webhook refreshes the balance from the provider (not from transactions)
`src/modules/webhooks/moralis-handlers.ts` (the connected transfer path).
- Keep appending the incoming transfer as a `Transaction` (the activity feed).
- After processing the webhook's transfers for a connected portfolio, **refresh balances from the
  provider** — export and call `setConnectedBalancesFromSummary(portfolioId, resolveHeldTokens(await
  fetchWalletSummary(addr, chain)))` (a mini-resync of balances only). That makes live updates reflect
  the real on-chain balance instead of the windowed recompute. Best-effort: a provider failure leaves
  the feed write intact and just defers the balance refresh to the next sync.
- (If a full summary per webhook is too heavy later, narrow it to the affected token's current balance —
  but summary is simplest and webhooks are infrequent. Note it, don't pre-optimize.)

## 3. Load-more stays feed-only
`importMoreTransfers` (sync.ts). Older transfers don't change the *current* balance, so after the
recalc-skip from §1 this is already correct — just confirm load-more does **not** re-run a balance
recompute for connected. (No `setConnectedBalancesFromSummary` needed here; balance is unchanged.)

## 4. Export the helper
Export `setConnectedBalancesFromSummary` (and reuse `resolveHeldTokens`) from `sync.ts` for the webhook
path in §2.

## Validate
- **Load-more** on the test wallet (id 13): balances stay provider-truth (ETH 0.00565, zero negatives) —
  no reversion. (Before this, load-more reverted to the windowed sum.)
- **Webhook**: simulate a connected transfer webhook → the tx shows in the feed AND the balance reflects
  the provider's new balance, not a windowed recompute.
- **Manual regression**: a manual portfolio's recalc / balance / netDeposit are byte-identical
  (diff before/after). The manual transaction-CUD tests stay green.
- Suites green: transactions, wallet-preview, webhooks (moralis-handlers), overview.

## Out of scope
Manual-portfolio behaviour; Part 5b (historical 3-yr chart — separate, on Moralis price-by-block).
