# retrofit-73 — Input validation, transaction count, NFT floor/spam, payments history

**Audit refs:** R43 (zero-amount accepted), R44 (huge amount → 500), R45 (future date accepted),
H10 ("Total Transactions 421" vs 17 shown), H12 (NFT floor null), H13 (NFT spam), M19 (no payment history).

## R43/R44/R45 — transaction input validation (`transactions.schemas.ts` / service)
- **amount must be > 0** (currently `0` is accepted → 201 with $0). Reject zero (and ≤0) with 400.
- **upper bound**: an amount that overflows Decimal(20,8) currently throws → **500 INTERNAL_ERROR**.
  Validate max (≤ 1e12, or the precision limit) and return **400 VALIDATION_ERROR**, never a 500.
- **timestamp not in the future**: `timestamp ≤ now` (+ small clock-skew tolerance). A 2099 date is
  accepted today and corrupts the value-history reconstruction + chart x-axis.

## H10 — transaction count semantics
`/overview.totals.transactionCount` uses the connected wallet's on-chain `externalTxCount` (421) while the
transaction list only has the 17 imported rows. Make the headline "Transactions" = the count the list can
show (imported), and if you want to surface on-chain activity, add a separate, clearly-labeled stat
("On-chain txns") — don't label 421 "Total Transactions" next to a 17-row list.

## H12/H13 — NFT floor price + spam
- **floor/last-sale are null for all 56 NFTs** — the Moralis wallet-NFT endpoint doesn't return them.
  Either fetch floor via Moralis NFT price/collection-stats endpoint (or a marketplace API) during NFT
  sync and populate `Nft.floorPrice/floorPriceUsd/lastSale`, OR hide the floor/last-sale UI + the NFT
  "value" entirely and label the section "valuation unavailable" (don't imply $0).
- **spam**: Moralis NFT results carry a `possible_spam` boolean — persist it and filter (or badge) spam
  NFTs. The wallet shows "Hefty Presents" ×17, "Garbage Bags", null-collection items as holdings.

## M19 — payment history for active subscriptions
Payments shows "No payments yet" while the user has an active paid Pro Stripe sub. Persist a Payment row
on subscription activation / `invoice.paid` (Stripe webhook) so Payment History reflects real charges.

## Validate
- POST amount 0 → 400; amount 1e15 → 400 (not 500); timestamp 2099 → 400.
- Dashboard "Transactions" matches the list count (or on-chain count is separately labeled).
- NFTs show real floor/last-sale or a clean "valuation unavailable"; spam filtered/badged.
- Active Pro sub shows ≥1 payment in history.
- portfolios/transactions/nfts/subscriptions suites green; add tests for the three validation rejects.

## Frontend (Cowork — companion display fixes, done alongside)
R34 (sign wallet-ledger amounts −$ for sells), M13 (token-page allocation label "of this portfolio"),
M15 (wallet "assets" counts balance>0 only), M17 (NFT transfers shown with collection name, not "nft"),
M18 (relabel "Top Movers Today" → "Market movers").
