# retrofit-63 — Part D: transfer + NFT feed fallback (GoldRush/Alchemy), not Moralis-only

Balances already fall back across all four providers (`getSummary` on Moralis → GoldRush → Alchemy →
Ankr). But `getTransferHistory` and `getNftHoldings` are implemented **only** on Moralis — so a wallet
Moralis can't serve gets **correct balances but an empty transaction feed + NFT list**. Add these reads
to GoldRush (Covalent) and Alchemy so the feed degrades like everything else. **Moralis stays
primary/richest**; the others are fallbacks behind it in the existing `fetchTransferPage` /
`fetchNftHoldings` loops (first-non-null), so no orchestrator change is needed — just new provider
methods.

## ⚠️ Probe first (paste shapes; build to what you observe — the retrofit-54/60 discipline)
Confirm each endpoint's real response against the test wallet before writing a parser. Starting points:
- **Covalent/GoldRush transactions:** `GET /v1/{chain}/address/{address}/transactions_v3/` (paged) —
  confirm the page/cursor shape + per-tx fields (hash, from, to, value, decimals, gas, block_signed_at,
  log/transfer events for ERC-20). Map to `WalletTransfer` + a `TransferPage` (cursor + total).
- **Covalent/GoldRush NFTs:** `GET /v1/{chain}/address/{address}/balances_nft/` — confirm contract /
  token_id / name / image / collection fields. Map to `WalletNftHolding`.
- **Alchemy transfers:** `alchemy_getAssetTransfers` (category native+erc20+erc721/1155, `fromBlock`,
  `pageKey`) — confirm shape + pagination. Map to `WalletTransfer`.
- **Alchemy NFTs:** `getNFTsForOwner` — confirm shape. Map to `WalletNftHolding`.

## Implement
- Add `getTransferHistory` + `getNftHoldings` to `GoldRushWalletProvider` and `AlchemyWalletProvider`,
  mapping to the existing `WalletTransfer` / `WalletNftHolding` / `TransferPage` types so the rest of the
  sync path is unchanged.
- They slot into `fetchTransferPage` / `fetchNftHoldings` automatically (those already loop `PROVIDERS`
  first-non-null). Order stays Moralis-first.
- **Error handling (codebase standard):** any non-2xx (4xx AND 5xx) + network/parse error → `null` so the
  loop falls through; a 400/422 found in the probe is OUR request shape — fix it, don't record a false
  "provider can't serve this wallet."

## Validate
- Force Moralis off for a chain (or use a chain only GoldRush/Alchemy support): a connected wallet still
  gets a transfer page + NFT holdings from the fallback provider; balances unaffected.
- The decimal/usd/tokenId mapping matches Moralis's (so `importTransfers`/`importNftHoldings` behave the
  same regardless of which provider supplied the page).
- Manual portfolios untouched. Suites green (wallet-data, wallet-preview).

## Out of scope
Solana feed (provider-specific); historical-value providers (retrofit-60 already covers those).
