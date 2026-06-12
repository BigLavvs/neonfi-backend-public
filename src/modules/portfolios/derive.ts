// Derived portfolio fields — PnL stays 0 until Stage 13.
// TODO(Stage 13): PnL from BalanceSnapshot rows.
//
// Redis cache key pattern: `portfolio_pnl:<portfolioId>` (5-min TTL).
// Cache wiring is deferred to Stage 13. Do NOT write zeros to Redis here —
// writing 0s would make stale cache indistinguishable from real 0-balance portfolios.

import { prisma } from '../../lib/prisma.js';

export interface DerivedFields {
  totalValue: number;
  pnlAllTime: number;
  pnlAllTimeValue: number;
  pnl24h: number;
  pnl24hValue: number;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
}

export async function computeDerived(portfolioId: number): Promise<DerivedFields> {
  const assets = await prisma.asset.findMany({
    where: { portfolioId },
    include: { token: true },
  });

  let totalValue = 0;
  for (const a of assets) {
    const balance = Number(a.balance.toString());
    const price = Number(a.token.currentPrice.toString());
    totalValue += balance * price;
  }

  return {
    totalValue,
    pnlAllTime: 0,
    pnlAllTimeValue: 0,
    pnl24h: 0,
    pnl24hValue: 0,
    pnl7d: 0,
    pnl7dValue: 0,
    pnl30d: 0,
    pnl30dValue: 0,
  };
}
