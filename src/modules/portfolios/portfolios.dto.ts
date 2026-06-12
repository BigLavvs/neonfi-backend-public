import type { Prisma } from '@prisma/client';
import { slugify } from './slug.js';
import { computeDerived } from './derive.js';

export type PortfolioWithRelations = Prisma.PortfolioGetPayload<{
  include: { type: true; chain: true };
}>;

export interface PortfolioDTO {
  id: number;
  userId: number;
  name: string;
  slug: string;
  type: 'connected' | 'manual';
  walletAddress: string | null;
  chainId: number | null;
  startingBalance: number | null;
  netDeposit: number;
  totalValue: number;
  pnlAllTime: number;
  pnlAllTimeValue: number;
  pnl24h: number;
  pnl24hValue: number;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function toPortfolioDTO(portfolio: PortfolioWithRelations): Promise<PortfolioDTO> {
  const derived = await computeDerived(portfolio.id);
  return {
    id: portfolio.id,
    userId: portfolio.userId,
    name: portfolio.name,
    slug: slugify(portfolio.name),
    type: portfolio.type.name as 'connected' | 'manual',
    walletAddress: portfolio.walletAddress ?? null,
    chainId: portfolio.chainId ?? null,
    startingBalance:
      portfolio.startingBalance !== null
        ? Number(portfolio.startingBalance.toString())
        : null,
    netDeposit: Number(portfolio.netDeposit.toString()),
    ...derived,
    createdAt: portfolio.createdAt,
    updatedAt: portfolio.updatedAt,
  };
}
