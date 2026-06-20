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
  // retrofit-79 (§1c/§4): null for a CONNECTED wallet with no provider cost basis ("—"),
  // otherwise the cost-basis (connected) / netDeposit (manual) all-time.
  pnlAllTime: number | null;
  pnlAllTimeValue: number | null;
  // retrofit-27: average-cost PnL (new model, additive). allTimePnlValue = unrealized +
  // realized. The legacy pnlAllTime*/netDeposit numbers above are kept unchanged.
  unrealizedPnlValue: number;
  unrealizedPnlPct: number;
  realizedPnlValue: number;
  allTimePnlValue: number;
  // retrofit-79 (§6): Σ Asset.costBasis over cost-tracked assets (the connected "Total invested"
  // floor); carried through from derive.ts.
  costBasisTotal: number;
  // retrofit-79 (§2/D1): null when there's no approx=false snapshot baseline for the window.
  pnl24h: number | null;
  pnl24hValue: number | null;
  pnl7d: number | null;
  pnl7dValue: number | null;
  pnl30d: number | null;
  pnl30dValue: number | null;
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
