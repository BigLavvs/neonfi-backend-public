# retrofit-55 — Widen Nft.logoUrl so on-chain data: URI images don't overflow

retrofit-54's correct NFT endpoint surfaced a column-size bug CC hit during the resync: a few NFTs
(e.g. Uniswap V3 LP positions, contract `0xc36442…fe88`) carry their image as a giant on-chain base64
`data:image/svg+xml;base64,…` URI. That overflows `Nft.logoUrl @db.VarChar(2048)`, so `nft.upsert`
throws "value too long for the column" and those NFTs silently skip (caught per-item — no crash, not a
regression, but they show the placeholder instead of their art).

## Fix — widen the column to TEXT (keep the image)
Uniswap V3 positions have meaningful generative on-chain SVG art, and `data:` URIs render fine in an
`<img>`, so the right fix is to STORE them, not drop them.

`prisma/schema.prisma`, `Nft.logoUrl`:
```prisma
logoUrl String? @db.Text   // was @db.VarChar(2048) — on-chain data: URI SVGs (e.g. Uniswap V3) overflow 2048
```

Migration: `migrate dev` is still blocked by the `asset_avg_cost_opening` checksum drift, so use the
established workaround — hand-write the additive migration from `migrate diff` output
(`ALTER TABLE "nft" ALTER COLUMN "logoUrl" TYPE TEXT;`), apply via `db execute` to **neonfi_dev** +
**neonfi_test**, then `migrate resolve --applied` on both, and `prisma generate`.

No `getNftHoldings` code change: `toHttpImage` already passes `data:` URIs through unchanged, and the
media → normalized image → collection_logo precedence stays the same.

## Payload note (acceptable; flag only if it bites)
The NFT DTO now carries multi-KB `data:` URIs for these NFTs (~5–15KB each, a handful per wallet —
bounded). If a wallet with many LP positions ever bloats the wallet/overview payload, the fallback is
to drop `data:`-scheme images in `getNftHoldings` (fall back to `collection_logo`). Default: keep them.

## Validate
- typecheck + singleton check clean.
- Resync the connected wallet → the Uniswap V3 position NFTs import with **no** "value too long";
  their `logoUrl` holds the data: URI and they render in the list + modal. NFT row count stable.
- Regression: `nfts` + `wallet-data` + `wallet-preview` suites green.

## Out of scope
Manual portfolios; floor price; the webhook path.
