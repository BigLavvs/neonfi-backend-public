import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import type { AssetWithToken } from './assets.dto.js';

export async function findAllAssetsByPortfolioId(portfolioId: number): Promise<AssetWithToken[]> {
  return prisma.asset.findMany({
    where: { portfolioId },
    include: { token: true },
    orderBy: { id: 'asc' },
  });
}

export async function findAssetById(id: number): Promise<AssetWithToken | null> {
  return prisma.asset.findUnique({ where: { id }, include: { token: true } });
}

export async function findAssetByPortfolioToken(
  portfolioId: number,
  tokenId: number,
): Promise<AssetWithToken | null> {
  return prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId } },
    include: { token: true },
  });
}

export async function createAssetRow(data: {
  portfolioId: number;
  tokenId: number;
}): Promise<AssetWithToken> {
  return prisma.asset.create({ data, include: { token: true } });
}

// retrofit-44: optional `tx` allows the opening edit to run atomically with recalc.
// Prisma ignores undefined fields in `data`, so partial updates work correctly.
export async function updateAssetRow(
  id: number,
  data: {
    netDeposit?: string;
    openingBalance?: string;
    openingCostBasis?: string | null;
    openingAt?: Date | null;
  },
  tx?: PrismaTransactionClient,
): Promise<AssetWithToken> {
  return (tx ?? prisma).asset.update({ where: { id }, data, include: { token: true } });
}

export async function deleteAssetRow(id: number): Promise<void> {
  await prisma.asset.delete({ where: { id } });
}
