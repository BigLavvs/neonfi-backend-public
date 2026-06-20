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
import { getLivePriceMap } from '../../lib/live-price.js';
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

// retrofit-15: these caches are price-dependent (summary.totalValue and holdings values
// track live price), so dropped from 5 min to 60s to match the `price:<SYMBOL>` TTL —
// "latest at page-load" only holds if the cache can't outlive a tick. Performance
// (snapshot series) isn't price-sensitive but shares the constant; the extra recompute
// is cheap at MVP scale.
const CACHE_TTL_S = 60;

/**
 * Round a derived analytics metric to a fixed wire scale. These values are JS-float
 * derivations (Number(decimal) + arithmetic) that carry representation noise
 * (e.g. 16.250000000000004); 2dp matches the architecture reps and hands the frontend
 * clean numbers to format. `dp` is the single knob — bump the default to 3 for finer
 * percentage granularity (Idowu's call).
 */
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// retrofit-79 (§2/§4): null-preserving round — an unknown PnL (no baseline / no cost basis)
// stays null on the wire so the frontend renders "—" rather than a fabricated 0.
function roundN(n: number | null, dp = 2): number | null {
  return n == null ? null : round(n, dp);
}

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

// Period PnL from a past snapshot value. retrofit-79 (§2/D1): no snapshot in the window (or a
// zero baseline) → [null, null] ("unknown", the UI shows "—"), distinct from a real flat 0.
function computePnlPeriod(today: number, pastValue: number | null): [number | null, number | null] {
  if (pastValue === null || pastValue === 0) return [null, null];
  const delta = today - pastValue;
  const pct = (delta / pastValue) * 100;
  return [pct, delta];
}

async function buildSummary(portfolioId: number, isConnected: boolean): Promise<SummaryDTO> {
  // all-time numbers + current totalValue come from derive.ts (already cached at
  // portfolio_pnl:<id>); no need to duplicate that cost-basis logic here.
  const derived = await computeDerived(portfolioId);

  // retrofit-72 (H9/R37): a connected wallet's imported transfers are a windowed, effectively
  // one-directional ledger — summing them into deposits/withdrawals is misleading ($0.41 in vs
  // $516 out is impossible), so skip the read entirely and report null. Manual portfolios keep
  // the real cost-basis ledger.
  const [totals, snap7d, snap30d] = await Promise.all([
    isConnected ? Promise.resolve(null) : getDepositWithdrawalTotals(portfolioId),
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

  // retrofit-79 (§6): a connected wallet WITH provider cost basis (pnlAllTimeValue non-null)
  // surfaces "Total invested" (Σ current Asset.costBasis, the floor) + "Realized" (Σ per-token
  // realized PnL) in place of the misleading windowed deposits/withdrawals (which stay null).
  // Manual keeps its real Deposits/Withdrawals; connected w/o cost basis gets all four null (§4).
  const connectedWithCostBasis = isConnected && derived.pnlAllTimeValue !== null;

  return {
    portfolioId,
    allTimePnlPct: roundN(derived.pnlAllTime),
    allTimePnlValue: roundN(derived.pnlAllTimeValue),
    totalDeposits: totals ? round(totals.totalDeposits) : null,
    totalWithdrawals: totals ? round(totals.totalWithdrawals) : null,
    totalInvested: connectedWithCostBasis ? round(derived.costBasisTotal) : null,
    realizedPnl: connectedWithCostBasis ? round(derived.realizedPnlValue) : null,
    pnl7d: roundN(pnl7d),
    pnl7dValue: roundN(pnl7dValue),
    pnl30d: roundN(pnl30d),
    pnl30dValue: roundN(pnl30dValue),
  };
}

async function buildPerformance(portfolioId: number): Promise<PerformanceDTO> {
  const snapshots = await findAllSnapshotsAscByPortfolio(portfolioId);
  return {
    portfolioId,
    snapshots: snapshots.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: round(Number(s.value.toString())),
    })),
  };
}

async function buildHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  const assets = await findAllAssetsByPortfolioId(portfolio.id);
  // retrofit-15: overlay live `price:<SYMBOL>` ticks over the seeded currentPrice — both
  // in the totalValue denominator and per-holding value; a miss falls back to currentPrice.
  const priceMap = await getLivePriceMap(assets.map((a) => a.token.symbol));
  const totalValue = computeTotalValue(assets, priceMap);

  const items = assets
    .map((a) => ({
      symbol: a.token.symbol,
      balance: Number(a.balance.toString()),
      price: priceMap.get(a.token.symbol) ?? Number(a.token.currentPrice.toString()),
    }))
    .filter((a) => a.balance > 0)
    .map((a) => {
      const value = a.balance * a.price;
      const portfolioPercentage = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return { symbol: a.symbol, value, portfolioPercentage };
    })
    .sort((a, b) => b.value - a.value)
    .map((a) => ({
      symbol: a.symbol,
      value: round(a.value),
      portfolioPercentage: round(a.portfolioPercentage),
    }));

  return { portfolioId: portfolio.id, assets: items };
}

// ---------------------------------------------------------------------------
// Public, cache-wrapped entry points (called by the controller)
// ---------------------------------------------------------------------------

export function getSummary(portfolioId: number, isConnected: boolean): Promise<SummaryDTO> {
  return withCache(`analytics_summary:${portfolioId}`, () => buildSummary(portfolioId, isConnected));
}

export function getPerformance(portfolioId: number): Promise<PerformanceDTO> {
  return withCache(`analytics_performance:${portfolioId}`, () => buildPerformance(portfolioId));
}

export function getHoldings(portfolio: PortfolioWithRelations): Promise<HoldingsDTO> {
  return withCache(`analytics_holdings:${portfolio.id}`, () => buildHoldings(portfolio));
}
