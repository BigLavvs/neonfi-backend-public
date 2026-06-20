import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { effectiveNftSpam } from '../wallet-data/nft-spam.js';
import { findAllNftsByPortfolioId, findNftById, updateNftSpamOverride } from './nfts.repository.js';
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

export interface NftListResult {
  nfts: NftDTO[];
  // retrofit-84 (H13): how many spam NFTs are hidden — drives the frontend "Show spam (N)" toggle.
  spamCount: number;
}

export async function listNfts(
  portfolio: PortfolioWithRelations,
  opts: { includeSpam?: boolean } = {},
): Promise<NftListResult> {
  // Manual portfolios have no wallet address — no on-chain NFT ownership state.
  // Return empty list so frontend NFT tab renders gracefully.
  if (portfolio.type.name !== 'connected') {
    return { nfts: [], spamCount: 0 };
  }
  // retrofit-73/84/86 (H13/H13.1): hide spam (airdrop/scam) NFTs from the default holdings list +
  // count so the wallet doesn't show "Hefty Presents" ×17 / "Garbage Bags" as real holdings.
  // Filtering is on the EFFECTIVE verdict — the combined `spam` signal with the per-NFT manual
  // override applied (spamOverride ?? spam) — not the raw provider flag. Nothing is deleted:
  // `?includeSpam=true` (the "Show spam" toggle) returns the full set so the user can audit, and
  // `spamCount` always reports how many are hidden so the toggle can label itself.
  const rows = await findAllNftsByPortfolioId(portfolio.id);
  const spamCount = rows.reduce((n, r) => (effectiveNftSpam(r) ? n + 1 : n), 0);
  const visible = opts.includeSpam ? rows : rows.filter((n) => !effectiveNftSpam(n));
  return {
    nfts: visible.map((n) => toNftDTO(n, portfolio.walletAddress)),
    spamCount,
  };
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

// retrofit-86 (H13.1): set/clear the per-NFT manual spam override (the two-way escape hatch).
// spamOverride: true = force spam (hide), false = force visible, null = clear (use computed verdict).
export async function setNftSpamOverride(
  portfolio: PortfolioWithRelations,
  nftId: number,
  spamOverride: boolean | null,
): Promise<NftDTO> {
  const nft = await findNftById(nftId);
  if (!nft || nft.portfolioId !== portfolio.id) {
    throw new NftError(404, 'NFT_NOT_FOUND', 'NFT not found');
  }
  const updated = await updateNftSpamOverride(nftId, spamOverride);
  return toNftDTO(updated, portfolio.walletAddress);
}
