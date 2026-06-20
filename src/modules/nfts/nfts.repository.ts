import type { Nft } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export async function findAllNftsByPortfolioId(portfolioId: number): Promise<Nft[]> {
  return prisma.nft.findMany({
    where: { portfolioId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findNftById(id: number): Promise<Nft | null> {
  return prisma.nft.findUnique({ where: { id } });
}

// retrofit-86 (H13.1): set/clear the per-NFT manual spam override (null clears it). The computed
// `spam` column is left untouched — the override wins at read time (effectiveNftSpam).
export async function updateNftSpamOverride(id: number, spamOverride: boolean | null): Promise<Nft> {
  return prisma.nft.update({ where: { id }, data: { spamOverride } });
}
