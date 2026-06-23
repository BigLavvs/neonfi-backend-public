# retrofit-58 — Connected-wallet correctness overhaul (bundle)

Fixes the connected-portfolio calculation breakdown that retrofit-57 traced, plus the two incidental
bugs it surfaced. **Manual portfolios are NOT touched anywhere in this retrofit** — every change is
gated on `type === 'connected'`. Land the parts in order; each has its own validation, so commit
per-part (or in two commits: Parts 1–4, then Part 5).

### Ground truth from the retrofit-57 trace (wallet 0xcB1C…905, eth)
- The provider summary is **correct and small**: real net worth **$12.25**, ETH **0.00565**, BUSD $2.10,
  rest dust. Sold tokens (UNI/USDC/WBTC/CBETH/WETH) are **absent** from the summary.
- The app stored ETH at 0.0775 ($131) and left UNI/USDC/WBTC/CBETH negative (≈ −$146). `computeDerived`
  → $29.70, positive-only headline → $175.91. Both wrong; only $12.25/$12.23 are right.
- Cause: balances are rebuilt from a **windowed** transfer set (≈134 of 420 txs) + a one-directional
  reconcile — `reconcileOpeningLots` iterates `held` only (sync.ts:400) and only seeds a *positive*
  residual (line 407), so sold tokens stay negative and overshooting held tokens are never trimmed.

The key realization: **the provider already returns correct current balances**, so we don't reconstruct
the present at all — we just trust the summary. Reconstruction is only needed for *historical* value
(Part 5).

---

## Part 1 — Connected current balances FROM the provider summary (the core fix)
`src/modules/wallet-data/sync.ts`, in `syncConnectedHoldings` AND `resyncConnectedHoldings`.

Replace the opening-lot reconciliation for connected with a direct authoritative set:
- Keep `importTransfers` (it still writes the `Transaction` rows for the feed/markers).
- **After** import, set balances from the provider summary (`resolveHeldTokens(summary)` already has them):
  - For every token in the summary: upsert its `Asset` and set `balance = provider balance` (exact).
  - For every existing `Asset` on the portfolio **not** in the summary: set `balance = 0` (sold out).
  - Do **not** seed opening lots, do **not** keep the transaction-derived balance.
- Drop `reconcileOpeningLots` / `reconcileWalletOpeningLot` from the connected path (or replace their body
  with the direct-set above). The residual/`WALLET_SYNC_OPENING_NOTE` machinery is no longer used for
  connected.

Result: `Asset.balance` = provider truth for every token → no negatives, no inflation. Current value,
allocation, and net worth all become correct ($12.25).

**Validate:** resync this wallet → ETH 0.00565, no negative balances, `computeDerived.totalValue` ≈ the
provider's `summary.totalUsd` (≈ $12.25), positive-only == all (they now agree). Regression: a manual
portfolio's balances are byte-identical.

## Part 2 — Connected PnL from recorded value history (not windowed cost basis)
`src/modules/portfolios/derive.ts` + `src/modules/overview/overview.service.ts`.

A windowed transaction set can't yield a trustworthy cost basis/`netDeposit`, so cost-basis PnL is
meaningless for connected. For `type === 'connected'` compute PnL from `BalanceSnapshot` deltas instead:
- `pnl24h/7d/30d` = `currentValue − snapshot(N days ago)` over that snapshot (overview already does 24h
  this way — extend it for connected; reuse `findSnapshotNearDaysAgo`).
- All-time = `currentValue − earliest recorded snapshot value` (honest "growth since tracking began" —
  we don't know true cost). Surface it as such.
- Unrealized/cost-basis PnL: **N/A** for connected (avgCost is unreliable) → 0 / hidden.
- **Manual portfolios keep the existing cost-basis PnL untouched** — branch on type.

**Validate:** connected PnL is sane (no +518%/+1314%); manual PnL unchanged (diff a manual portfolio's
overview before/after — identical).

## Part 3 — Moralis Streams endpoint (live webhook updates are silently dead)
`src/lib/moralis-streams-client.ts`. Creating a stream `POST https://api.moralis-streams.com/streams/evm`
returns **404 "Cannot POST"**, so `moralisStreamId` is always null and connected wallets only refresh on
manual resync. Same class as the retrofit-54 NFT-path bug.

**Probe first** (don't guess): the Moralis Streams "Create Stream" verb is almost certainly **PUT**, not
POST (`PUT /streams/evm`); add-address is `POST /streams/evm/{id}/address`. Hit the real API with the key
and confirm the verb/route that returns 2xx, then fix the client to match. Paste the probe result.

**Validate:** creating a connected portfolio now returns a real `moralisStreamId`; a test webhook (or the
Moralis dashboard) shows the address subscribed. Best-effort: a stream failure must still not block sync.

## Part 4 — Token symbol/name column overflow
A scam token's symbol/name overflows its `Token` column ("value too long", auto-list skipped). Widen the
offending column(s) — `Token.symbol` / `Token.name` (and any other `VarChar` an arbitrary on-chain string
flows into) to a generous length or `@db.Text`. Use the established migrate workaround (hand-write the
`ALTER ... TYPE TEXT` from `migrate diff`, apply to dev+test, `migrate resolve --applied`, `generate`).

**Validate:** the previously-skipped token auto-lists on resync without throwing; suites green.

---

## Part 5 — Historical value back to ~3 years (#4) — ⚠️ SUPERSEDED BY retrofit-60 — DO NOT BUILD
**Skip this. Answer CC's Part-5b menu with option 4 (Hold Part 5b).** The transaction-replay
reconstruction described below was replaced by **retrofit-60**'s provider chain (Zerion/Mobula one-call
multi-year → GoldRush 1-yr → Moralis capped `to_block` sampling), which is cheaper and flat in wallet
activity. The text below is kept only for history.

(superseded) This part reconstructs (for the chart, never for current balances, which Part 1 fixed).
It has an external dependency we have **not** validated, so it starts with a probe — same discipline that
caught the NFT, GoldRush, and Streams issues. **Do the probe, paste the output, and stop there for my
sign-off on the parser before implementing.**

### 5a. Probe (read-only, paste results)
- **Historical prices (CoinGecko):** for ~3 of the wallet's tokens (ETH + 2 others), resolve the coin id
  (`/api/v3/coins/list?include_platform=true`, or `/coins/ethereum/contract/{address}`) and fetch
  `/api/v3/coins/{id}/market_chart/range?vs_currency=usd&from=&to=` over a ~2-year range. Report: does it
  return daily points across years? field shape? rate-limit behaviour? which obscure tokens (PEPU/HEX
  type) have **no** history?
- **Opening balances at a past block (Moralis):** confirm timestamp→block (`/dateToBlock`) and token
  balances at `to_block=B0` (B0 = 3 years ago) return for this wallet.

### 5b. Intended implementation (finalize after the probe)
- Window = last **3 years** (or first activity if sooner) → block **B0**.
- Opening = token balances at B0 for **all** tokens (not held-only). Import **all** transactions in
  `(B0 → now]`.
- Reconstruct daily value = `holdings(day) × historical price(day)`, `holdings(day)` from `opening(B0) +
  transactions ≤ day`. Store as `BalanceSnapshot` so the existing chart path serves it.
- **Stitch the "now" endpoint to the Part-1 provider value** so the chart's right edge equals the headline
  (no drift). Cap the transaction import by the 3-year window (+ a tx-count cap) so whale wallets degrade
  gracefully.
- Missing-price days: carry forward the last known price (don't zero the token out). Daily-close
  granularity is acceptable.

**Validate:** the connected ALL chart extends toward 2024 (as far as price history allows), its newest
point equals the corrected headline, and a token with no historical price is carried-forward (not a
spike to zero).

---

## Out of scope / notes
- No manual-portfolio behaviour changes anywhere.
- Frontend follow-up (mine, after backend lands): the dashboard headline should use the corrected single
  total — drop the positive-only live recompute for connected, since Part 1 makes the backend total
  correct. I'll handle that once Parts 1–2 are in.
