import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { findAllNftsByPortfolioId, findNftById } from './nfts.repository.js';
import { toNftDTO, type NftDTO } from './nfts.dto.js';

export class NftError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NftError';
  }
}

export async function listNfts(portfolio: PortfolioWithRelations): Promise<NftDTO[]> {
  // Manual portfolios have no wallet address — no on-chain NFT ownership state.
  // Return empty list so frontend NFT tab renders gracefully.
  if (portfolio.type.name !== 'connected') {
    return [];
  }
  const nfts = await findAllNftsByPortfolioId(portfolio.id);
  return nfts.map((n) => toNftDTO(n, portfolio.walletAddress));
}

export async function getNftById(
  portfolio: PortfolioWithRelations,
  nftId: number,
): Promise<NftDTO> {
  const nft = await findNftById(nftId);
  if (!nft || nft.portfolioId !== portfolio.id) {
    throw new NftError(404, 'NFT_NOT_FOUND', 'NFT not found');
  }
  return toNftDTO(nft, portfolio.walletAddress);
}
