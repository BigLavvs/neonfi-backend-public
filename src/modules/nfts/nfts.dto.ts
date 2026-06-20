import type { Nft } from '@prisma/client';
import { effectiveNftSpam } from '../wallet-data/nft-spam.js';

export interface NftDTO {
  id: number;
  portfolioId: number;
  name: string | null;
  description: string | null;
  tokenId: string;
  contractAddress: string;
  owner: string | null;
  collectionName: string | null;
  logoUrl: string | null;
  chain: string;
  tokenStandard: string | null;
  floorPrice: string | null;
  floorPriceUsd: string | null;
  lastSale: string | null;
  lastSaleNote: string | null;
  rarity: string | null;
  traits: unknown | null;
  // retrofit-73 (H13): the RAW provider spam flag (Moralis possible_spam / Alchemy isSpam) on the
  // source row. Kept for provenance; the list now filters on the combined `spam` verdict below.
  possibleSpam: boolean;
  // retrofit-84/86 (H13/H13.1): the EFFECTIVE spam verdict the frontend filters/badges on — the
  // computed signal OR-stack with the manual override applied (spamOverride ?? spam). Spam is hidden
  // from the default holdings list; the flag is exposed so the "Show spam" toggle can badge revealed
  // ones. No frontend change needed — this is the same boolean field, now override-aware.
  spam: boolean;
  // retrofit-86 (H13.1): the raw manual override (true = forced spam, false = forced visible, null =
  // none). Exposed for a future flag/unflag UI; the `spam` field above already folds it in.
  spamOverride: boolean | null;
  createdAt: Date;
}

export function toNftDTO(nft: Nft, owner: string | null): NftDTO {
  return {
    id: nft.id,
    portfolioId: nft.portfolioId,
    name: nft.name ?? null,
    description: nft.description ?? null,
    tokenId: nft.tokenId,
    contractAddress: nft.contractAddress,
    owner,
    collectionName: nft.collectionName ?? null,
    logoUrl: nft.logoUrl ?? null,
    chain: nft.chain,
    tokenStandard: nft.tokenStandard ?? null,
    floorPrice: nft.floorPrice ?? null,
    floorPriceUsd: nft.floorPriceUsd ?? null,
    lastSale: nft.lastSale ?? null,
    lastSaleNote: nft.lastSaleNote ?? null,
    rarity: nft.rarity ?? null,
    traits: nft.traits ?? null,
    possibleSpam: nft.possibleSpam,
    spam: effectiveNftSpam(nft),
    spamOverride: nft.spamOverride ?? null,
    createdAt: nft.createdAt,
  };
}
