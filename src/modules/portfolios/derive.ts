// Derived portfolio fields — current-state PnL computed from live Asset balances
// and the maintained Portfolio.netDeposit.
//
// What derive.ts OWNS: totalValue, pnlAllTime, pnlAllTimeValue (cost-basis PnL
// against Portfolio.netDeposit, maintained by retrofit-2).
// What it does NOT own (for MANUAL portfolios): 24h/7d/30d PnL — those need historical
// BalanceSnapshot rows, a cross-module read that belongs in the Stage 14 analytics module
// (architecture line 1194-1212). They stay 0 here for manual.
//
// retrofit-58 Part 2: CONNECTED portfolios are different. Their balances are set directly
// from the provider summary (Part 1), so a windowed transfer import gives them no trustworthy
// cost basis — cost-basis PnL would be fictional (the +518%/+1314% retrofit-57 saw). For
// `type === 'connected'` we instead compute PnL from recorded BalanceSnapshot deltas: all-time
// = currentValue − the EARLIEST recorded snapshot ("growth since tracking began"), and
// 24h/7d/30d = currentValue − the snapshot nearest N days ago. Unrealized/realized/cost-basis
// are N/A → 0. Manual portfolios keep the exact existing cost-basis path (branch on type).
//
// Redis cache (retrofit-3 §1.5): key `portfolio_pnl:<portfolioId>`, 5-min TTL.
// Invalidated on transaction CUD (retrofit-2, transactions.service.ts) and on
// snapshot write (retrofit-3, snapshot.job.ts). A Redis failure never blocks the
// read — every cache call is `.catch`-guarded and falls through to DB compute.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getLivePriceMap } from '../../lib/live-price.js';
import {
  findSnapshotNearDaysAgo,
  findEarliestSnapshotByPortfolio,
} from '../snapshots/snapshots.service.js';

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
      select: { netDeposit: true, type: { select: { name: true } } },
    }),
  ]);

  // retrofit-15: prefer the live `price:<SYMBOL>` tick over the seeded currentPrice.
  // One mget for the portfolio's symbols; misses fall back to currentPrice.
  const liveMap = await getLivePriceMap(assets.map((a) => a.token.symbol));

  // totalValue is computed the same way for both portfolio types (live-overlaid balances).
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

  // retrofit-58 Part 2: connected portfolios derive PnL from recorded snapshot deltas, not
  // cost basis (which a windowed import can't trust). Manual portfolios fall through to the
  // existing cost-basis path below, BYTE-for-byte unchanged.
  if (portfolio?.type?.name === 'connected') {
    return computeConnectedDerived(portfolioId, totalValue);
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

// retrofit-58 Part 2: PnL for a CONNECTED portfolio, derived from recorded BalanceSnapshot
// deltas (never cost basis). all-time = currentValue − the earliest recorded snapshot; 24h/7d/
// 30d = currentValue − the snapshot nearest N days ago. The legacy pnlAllTime* fields are
// repurposed to carry this honest "growth since tracking began" number (so the overview totals,
// which sum pnlAllTimeValue and recompute the % over the implied baseline, stay consistent).
// Unrealized/realized/avg-cost are N/A for connected → 0. No snapshot in a window → 0/0 (a
// freshly connected wallet shows +$0.00 until history accrues), never NaN/Infinity.
async function computeConnectedDerived(
  portfolioId: number,
  totalValue: number,
): Promise<DerivedFields> {
  const [earliest, snap1, snap7, snap30] = await Promise.all([
    findEarliestSnapshotByPortfolio(portfolioId),
    findSnapshotNearDaysAgo(portfolioId, 1),
    findSnapshotNearDaysAgo(portfolioId, 7),
    findSnapshotNearDaysAgo(portfolioId, 30),
  ]);

  // currentValue − baseline; % over the baseline (guard divide-by-zero → 0).
  const delta = (base: { value: { toString(): string } } | null): { value: number; pct: number } => {
    if (!base) return { value: 0, pct: 0 };
    const b = Number(base.value.toString());
    const value = totalValue - b;
    return { value, pct: b !== 0 ? (value / b) * 100 : 0 };
  };

  const all = delta(earliest);
  const d1 = delta(snap1);
  const d7 = delta(snap7);
  const d30 = delta(snap30);

  return {
    totalValue,
    pnlAllTime: all.pct,
    pnlAllTimeValue: all.value,
    // Cost-basis PnL is N/A for connected (no trustworthy avgCost from a windowed import).
    unrealizedPnlValue: 0,
    unrealizedPnlPct: 0,
    realizedPnlValue: 0,
    allTimePnlValue: 0,
    pnl24h: d1.pct,
    pnl24hValue: d1.value,
    pnl7d: d7.pct,
    pnl7dValue: d7.value,
    pnl30d: d30.pct,
    pnl30dValue: d30.value,
  };
}
