import type { Nft } from '@prisma/client';

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
    createdAt: nft.createdAt,
  };
}
