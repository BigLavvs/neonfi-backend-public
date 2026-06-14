// Derived portfolio fields — current-state PnL computed from live Asset balances
// and the maintained Portfolio.netDeposit.
//
// What derive.ts OWNS: totalValue, pnlAllTime, pnlAllTimeValue (cost-basis PnL
// against Portfolio.netDeposit, maintained by retrofit-2).
// What it does NOT own: 24h/7d/30d PnL — those need historical BalanceSnapshot
// rows, a cross-module read that belongs in the Stage 14 analytics module
// (architecture line 1194-1212). They stay 0 here.
//
// Redis cache (retrofit-3 §1.5): key `portfolio_pnl:<portfolioId>`, 5-min TTL.
// Invalidated on transaction CUD (retrofit-2, transactions.service.ts) and on
// snapshot write (retrofit-3, snapshot.job.ts). A Redis failure never blocks the
// read — every cache call is `.catch`-guarded and falls through to DB compute.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

const CACHE_TTL_S = 300;

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
  // 1. Cache check — a malformed/short payload falls through to recompute.
  const cached = await redis.get(`portfolio_pnl:${portfolioId}`).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DerivedFields;
      if (typeof parsed.totalValue === 'number' && typeof parsed.pnlAllTime === 'number') {
        return parsed;
      }
    } catch {
      // Fall through to recompute
    }
  }

  // 2. Compute from DB
  const result = await computeFromDb(portfolioId);

  // 3. Write back to cache. Never let a Redis failure roll back the read.
  // Process-safe but not race-proof (retrofit-3 §1.9): two concurrent misses both
  // compute and both write; the second wins. Values are deterministic for the same
  // Asset state, so a last-writer-wins race is harmless — no distributed lock at
  // MVP scale.
  await redis
    .set(`portfolio_pnl:${portfolioId}`, JSON.stringify(result), 'EX', CACHE_TTL_S)
    .catch((e: Error) =>
      console.error(`[derive] cache set failed for portfolio ${portfolioId}:`, e.message),
    );

  return result;
}

async function computeFromDb(portfolioId: number): Promise<DerivedFields> {
  const [assets, portfolio] = await Promise.all([
    prisma.asset.findMany({
      where: { portfolioId },
      include: { token: true },
    }),
    prisma.portfolio.findUnique({
      where: { id: portfolioId },
      select: { netDeposit: true },
    }),
  ]);

  let totalValue = 0;
  for (const a of assets) {
    const balance = Number(a.balance.toString());
    const price = Number(a.token.currentPrice.toString());
    totalValue += balance * price;
  }

  // All-time PnL (retrofit-3 §1.6): now that Portfolio.netDeposit is maintained
  // (retrofit-2), pnlAllTimeValue = totalValue − netDeposit. Percentage is the
  // relative change vs cost basis; guard divide-by-zero for portfolios with no
  // deposits (return 0 rather than NaN/Infinity).
  const netDeposit = portfolio ? Number(portfolio.netDeposit.toString()) : 0;
  const pnlAllTimeValue = totalValue - netDeposit;
  const pnlAllTime = netDeposit !== 0 ? (pnlAllTimeValue / netDeposit) * 100 : 0;

  return {
    totalValue,
    pnlAllTime,
    pnlAllTimeValue,
    // 24h/7d/30d PnL needs historical snapshot data — owned by Stage 14 analytics
    // (cross-module read of BalanceSnapshot belongs there, not here).
    pnl24h: 0,
    pnl24hValue: 0,
    pnl7d: 0,
    pnl7dValue: 0,
    pnl30d: 0,
    pnl30dValue: 0,
  };
}
