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
