# retrofit-54 — Fix the Moralis NFT endpoint path (the actual root cause)

retrofit-53 (diagnostic) found it: `getNftHoldings` requests `/wallets/{address}/nfts`, which **404s
on every call** ("Cannot GET" — the route doesn't exist). The correct Moralis v2.2 route for
NFTs-by-wallet is `/{address}/nft` (singular, **no** `/wallets/` prefix). Tokens and history DO use
the `/wallets/` namespace (both return 200), but NFTs don't. So `getNftHoldings` has been hitting a
dead route and silently returning null (`if (!res.ok) return null`) the whole time — importing zero
NFT metadata. The `Nft` rows that exist came only from the transfer-history path, which writes
`name`/`contract`/`tokenId` but null `logoUrl`/`description`. retrofit-52's params were correct; the
URL they were attached to was wrong.

Verified live against the user's wallet: `GET /{address}/nft?chain=0x1&format=decimal&normalizeMetadata=true&media_items=true`
returns 200 with populated `normalized_metadata.image`, `normalized_metadata.description`,
`media.media_collection.high.url`, and `collection_logo` for real NFTs (ENS, Azuki, Beanz).

## The fix
`src/modules/wallet-data/providers/moralis.ts`, `getNftHoldings` (~line 380). Change the URL:
```ts
// WRONG (404 — /wallets/ prefix + plural /nfts):
// const url = `${this.deepIndexBase}/wallets/${address}/nfts?chain=${hex}&normalizeMetadata=true&media_items=true`;

// CORRECT (Moralis v2.2 NFTs-by-wallet is /{address}/nft, singular, no /wallets/ prefix):
const url = `${this.deepIndexBase}/${address}/nft?chain=${hex}&format=decimal&normalizeMetadata=true&media_items=true`;
```

### Why `format=decimal` is required (not optional)
The transfer-history import stores **decimal** `tokenId`s, and `Nft` has
`@@unique([portfolioId, contractAddress, tokenId])`. Moralis defaults NFT `token_id` to decimal, but
pin it explicitly with `format=decimal` so the holdings upsert matches the existing history-created
rows instead of inserting **duplicate** rows under a hex tokenId. Confirm after resync that NFT count
doesn't double.

## Nothing else changes
The response shape is identical (`json.result[]`, same `normalized_metadata` / `media` /
`collection_logo` fields retrofit-52 already reads), so the interface, the `media`→normalized→logo
precedence, the `toHttpImage` ipfs helper, and `importNftHoldings` all stay as-is. Just the path.

## Validate
- typecheck + singleton check clean.
- **Resync a connected wallet**, then re-query its `Nft` rows: `logoUrl` and `description` are now
  populated (they backfill via `importNftHoldings`' update branch). The modal shows real artwork +
  description; the list thumbnails show artwork.
- NFT row count is unchanged after resync (no hex/decimal duplicates).
- Regression: `nfts` + `wallet-preview` + `wallet-data` suites green. If `wallet-data` asserts the old
  `/wallets/{addr}/nfts` URL (the retrofit-52 unit test did), update the expected URL to the new path.

## Out of scope
Floor price (still "—" — needs a separate collection-stats call); manual portfolios; the webhook path.
