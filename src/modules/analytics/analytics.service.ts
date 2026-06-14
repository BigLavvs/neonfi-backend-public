// Neonfi backend — Analytics module service (Stage 14 §1.4-1.8).
//
// The Analytics module owns NO tables (architecture line 1194-1212). It composes
// derived data from three owner modules, reading each only through that module's
// public service/helper surface (module isolation, architecture line 1262-1263):
//   - all-time PnL + current totalValue ← portfolios/derive.ts (computeDerived)
//   - deposit/withdrawal totals          ← transactions.service.getDepositWithdrawalTotals
//   - 7d/30d comparison + timeseries     ← snapshots.service (findSnapshotNearDaysAgo,
//                                           findAllSnapshotsAscByPortfolio)
//   - current holdings                   ← assets.repository + assets.dto.computeTotalValue
//
// Each endpoint is wrapped in a 5-min Redis cache (Build Guide §2.5, architecture
// line 1207), keyed per portfolio. The cache is invalidated by transactions CUD
// (transactions.service.invalidatePnlCache) and snapshot writes (snapshot.job.ts),
// both via the shared portfolioDerivedCacheKeys list.

import { redis } from '../../lib/redis.js';
import { computeDerived } from '../portfolios/derive.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { getDepositWithdrawalTotals } from '../transactions/transactions.service.js';
import {
  findSnapshotNearDaysAgo,
  findAllSnapshotsAscByPortfolio,
} from '../snapshots/snapshots.service.js';
import { findAllAssetsByPortfolioId } from '../assets/assets.repository.js';
import { computeTotalValue } from '../assets/assets.dto.js';
import type { SummaryDTO, PerformanceDTO, HoldingsDTO } from './analytics.dto.js';

const CACHE_TTL_S = 300;

// Mirrors derive.ts's GET/parse/return-or-recompute pattern: a Redis miss or a
// malformed payload falls through to a fresh compute, and a SET failure logs but
// never blocks the read.
async function withCache<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // malformed payload — fall through to recompute
    }
  }
  const result = await compute();
  await redis
    .set(key, JSON.stringify(result), 'EX', CACHE_TTL_S)
    .catch((e: Error) => console.error(`[analytics] cache set failed for ${key}:`, e.message));
  return result;
}

// Period PnL from a past snapshot value. Null (no snapshot in the window) or a zero
// baseline → [0, 0]: "no historical comparison available", never NaN/Infinity.
function computePnlPeriod(today: number, pastValue: number | null): [number, number] {
  if (pastValue === null || pastValue === 0) return [0, 0];
  const delta = today - pastValue;
  const pct = (delta / pastValue) * 100;
  return [pct, delta];
}

async function buildSummary(portfolioId: number): Promise<SummaryDTO> {
  // all-time numbers + current totalValue come from derive.ts (already cached at
  // portfolio_pnl:<id>); no need to duplicate that cost-basis logic here.
  const derived = await computeDerived(portfolioId);

  const [{ totalDeposits, totalWithdrawals }, snap7d, snap30d] = await Promise.all([
    getDepositWithdrawalTotals(portfolioId),
    findSnapshotNearDaysAgo(portfolioId, 7),
    findSnapshotNearDaysAgo(portfolioId, 30),
  ]);

  const todayValue = derived.totalValue;
  const [pnl7d, pnl7dValue] = computePnlPeriod(
    todayValue,
    snap7d ? Number(snap7d.value.toString()) : null,
  );
  const [pnl30d, pnl30dValue] = computePnlPeriod(
    todayValue,
    snap30d ? Number(snap30d.value.toString()) : null,
  );

  return {
    portfolioId,
    allTimePnlPct: derived.pnlAllTime,
    allTimePnlValue: derived.pnlAllTimeValue,
    totalDeposits,
    totalWithdrawals,
    pnl7d,
    pnl7dValue,
    pnl30d,
    pnl30dValue,
  };
}

async function buildPerformance(portfolioId: number): Promise<PerformanceDTO> {
  const snapshots = await findAllSnapshotsAscByPortfolio(portfolioId);
  return {
    portfolioId,
    snapshots: snapshots.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: Number(s.value.toString()),
    })),
  };
}

async function buildHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  const assets = await findAllAssetsByPortfolioId(portfolio.id);
  const totalValue = computeTotalValue(assets);

  const items = assets
    .map((a) => ({
      symbol: a.token.symbol,
      balance: Number(a.balance.toString()),
      price: Number(a.token.currentPrice.toString()),
    }))
    .filter((a) => a.balance > 0)
    .map((a) => {
      const value = a.balance * a.price;
      const portfolioPercentage = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return { symbol: a.symbol, value, portfolioPercentage };
    })
    .sort((a, b) => b.value - a.value);

  return { portfolioId: portfolio.id, assets: items };
}

// ---------------------------------------------------------------------------
// Public, cache-wrapped entry points (called by the controller)
// ---------------------------------------------------------------------------

export function getSummary(portfolioId: number): Promise<SummaryDTO> {
  return withCache(`analytics_summary:${portfolioId}`, () => buildSummary(portfolioId));
}

export function getPerformance(portfolioId: number): Promise<PerformanceDTO> {
  return withCache(`analytics_performance:${portfolioId}`, () => buildPerformance(portfolioId));
}

export function getHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  return withCache(`analytics_holdings:${portfolio.id}`, () => buildHoldings(portfolio));
}
