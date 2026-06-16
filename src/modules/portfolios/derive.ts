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
import { getLivePriceMap } from '../../lib/live-price.js';

// retrofit-15: this cache is price-dependent (totalValue tracks live price), so it's
// dropped from 5 min to 60s to match the `price:<SYMBOL>` TTL — "latest at page-load"
// only holds if the cache can't outlive a tick. Reads only; the cost is a little more
// recompute, fine at MVP scale.
const CACHE_TTL_S = 60;

export interface DerivedFields {
  totalValue: number;
  // Legacy netDeposit-based all-time PnL (retrofit-2). KEPT and unchanged (retrofit-27
  // Augment): pnlAllTimeValue = totalValue − Portfolio.netDeposit. The analytics summary
  // still maps allTimePnl* from these.
  pnlAllTime: number;
  pnlAllTimeValue: number;
  // retrofit-27: average-cost PnL (the new model). unrealizedPnlValue = Σ over cost-tracked
  // assets of heldQty × (livePrice − avgCost); unrealizedPnlPct = that / Σ(costBasis) × 100
  // (0 with no cost basis); realizedPnlValue = Σ Asset.realizedPnl; allTimePnlValue =
  // unrealized + realized (the single avg-cost headline).
  unrealizedPnlValue: number;
  unrealizedPnlPct: number;
  realizedPnlValue: number;
  allTimePnlValue: number;
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

  // retrofit-15: prefer the live `price:<SYMBOL>` tick over the seeded currentPrice.
  // One mget for the portfolio's symbols; misses fall back to currentPrice.
  const liveMap = await getLivePriceMap(assets.map((a) => a.token.symbol));

  let totalValue = 0;
  // retrofit-27 average-cost accumulators. unrealized only counts cost-tracked assets
  // (avgCost != null); costBasis is the basis of currently-held cost-known units.
  let unrealizedPnlValue = 0;
  let costBasisSum = 0;
  let realizedPnlValue = 0;
  for (const a of assets) {
    const balance = Number(a.balance.toString());
    const price = liveMap.get(a.token.symbol) ?? Number(a.token.currentPrice.toString());
    totalValue += balance * price;

    realizedPnlValue += Number(a.realizedPnl.toString());
    if (a.avgCost !== null) {
      unrealizedPnlValue += balance * (price - Number(a.avgCost.toString()));
      costBasisSum += Number(a.costBasis.toString());
    }
  }

  // All-time PnL (retrofit-3 §1.6): now that Portfolio.netDeposit is maintained
  // (retrofit-2), pnlAllTimeValue = totalValue − netDeposit. Percentage is the
  // relative change vs cost basis; guard divide-by-zero for portfolios with no
  // deposits (return 0 rather than NaN/Infinity). KEPT unchanged by retrofit-27.
  const netDeposit = portfolio ? Number(portfolio.netDeposit.toString()) : 0;
  const pnlAllTimeValue = totalValue - netDeposit;
  const pnlAllTime = netDeposit !== 0 ? (pnlAllTimeValue / netDeposit) * 100 : 0;

  // retrofit-27 average-cost headline: unrealized % over Σ cost basis (guarded), and
  // all-time = unrealized + realized.
  const unrealizedPnlPct = costBasisSum !== 0 ? (unrealizedPnlValue / costBasisSum) * 100 : 0;
  const allTimePnlValue = unrealizedPnlValue + realizedPnlValue;

  return {
    totalValue,
    pnlAllTime,
    pnlAllTimeValue,
    unrealizedPnlValue,
    unrealizedPnlPct,
    realizedPnlValue,
    allTimePnlValue,
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
