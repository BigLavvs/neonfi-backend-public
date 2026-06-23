# retrofit-71 — Canonical token pricing + real history for auto-listed tokens; fix ATH/ATL & all-time labels

**Audit refs:** C4 (PEPU $0.00009 vs real $0.0000242 — 3.7×), C6 (auto-listed tokens have only 2
history points → fabricated charts/changes), C5 (ATH/ATL are 365-day window extremes mislabeled
"all-time"; real ETH ATH $4,946/ATL $0.43), C7 (token "all-time PnL" = trailing-1yr price return).

## C4 — validate auto-listed prices against a canonical feed
`sync.ts:135-148` auto-lists wallet tokens with `currentPrice = provider usdPrice` (Moralis), unverified.
On auto-list (and in the retrofit-48 connected-reprice job), resolve the token against the canonical
price source (CMC by contract address; CoinGecko `/coins/{platform}/contract/{address}` as fallback). If a
canonical price exists, use it; if the provider price deviates > ~25% from canonical, prefer canonical. If
NO canonical listing exists (truly obscure/spam token), keep the provider price but set a
`priceConfidence: 'unverified'` flag so the UI can mark/exclude it rather than presenting it as fact.

## C6 — backfill real price history for auto-listed tokens
Token history (`token_price_snapshot`) only accrues forward from when the token row was created, so
recently auto-listed tokens have n=2. On auto-list, enqueue a one-time historical backfill: fetch daily
prices for the token from the canonical provider (CMC/CoinGecko historical by contract) for the retention
window and `INSERT … ON CONFLICT DO NOTHING` into `token_price_snapshot`. Tokens with no canonical history
get a short/empty series — the UI must then show "limited history" instead of a fabricated 2-point chart.

## C5 — ATH/ATL: serve true all-time, or relabel
`tokens.service.ts:78` computes ath/atl as min/max over stored snapshots ("since tracking began"). Either:
- (preferred) store the provider's real ATH/ATL on `Token` (CMC `quote.USD.ath`/CoinGecko
  `market_data.ath/atl`) and serve those; or
- relabel the field in the UI to "1Y High/Low" (or the active range) — never "All-Time" unless it's the
  provider's true ATH/ATL.

## C7 — token "all-time PnL" label
The token-detail "All-time PnL" is `(currentPrice − price 365d ago)/price 365d ago` — a 1-year price
return, shown even when "Total invested $0.00". Either label it "1Y return", or (for a held position with
no cost basis) show "—" (consistent with retrofit-69: no basis → no PnL figure). Pick one and make the
token page consistent with the portfolio's all-time treatment.

## Validate
- PEPU price within a few % of CoinGecko (or flagged `unverified`); not 3.7× off.
- A freshly auto-listed token either has a real multi-point history or the UI shows "limited history" (no
  2-point line labeled "1M/1Y").
- ETH ATH/ATL == provider true values (or UI says "1Y High/Low").
- Token "all-time PnL" is labeled correctly or "—" when no basis.
- tokens + wallet-data suites green.
