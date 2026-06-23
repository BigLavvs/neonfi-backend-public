# retrofit-51 — Collect NFT description

The NFT image is already captured (the `Nft.logoUrl` from Moralis `normalized_metadata.image`); the
frontend now renders it and builds OpenSea/Blur links from contract+tokenId+chain. The one missing
piece of metadata is the **description**. Add it.

## 1. Schema
`prisma/schema.prisma`, `Nft` model — add:
```prisma
description String?  // retrofit-51: collectible description (normalized_metadata.description); null when absent
```
Migration: `npx prisma migrate dev --name nft_description` + `generate`.

## 2. Collect it (wallet-data import — retrofit-49)
- `src/modules/wallet-data/types.ts` `WalletNftHolding` — add `description: string | null`.
- `providers/moralis.ts` `getNftHoldings` — set `description: it.normalized_metadata?.description ?? null`
  (the holdings response already exposes `normalized_metadata`). Also add `description` to the NFT
  side of `getTransferHistory` if the history payload carries `normalized_metadata` (best-effort; null
  otherwise).
- `src/modules/wallet-data/sync.ts`:
  - `importNftHoldings` — write `description: h.description` in the `Nft` create, and in the update
    only when present (`...(h.description ? { description: h.description } : {})`), mirroring how
    `logoUrl`/`name` are handled.
  - `importNftTransfer` (the in-branch upsert) — same, when the transfer carries a description.
- The webhook stream NFT path (`moralis-handlers.ts processNftTransfers`) usually has no metadata, so
  leave it; the connect-time holdings import + the periodic resync backfill description over time.

## 3. Expose it (DTO)
Add `description` to the NFT DTO returned by `GET /portfolios/:id/nfts` (the `Nft → NftDTO` mapper):
`description: nft.description ?? null`. The frontend already reads `description` off the DTO (defaults
to '' until this ships).

## 4. Validate
- typecheck + singleton check clean.
- Sync a wallet whose NFT has a description → the `Nft` row stores it and the DTO returns it.
- An NFT with no description → null/'' (no crash, no empty section in the UI).
- Regression: nfts + wallet-preview suites green.

## Out of scope
- The Moralis stream/webhook path, manual portfolios, anything beyond the description field.
