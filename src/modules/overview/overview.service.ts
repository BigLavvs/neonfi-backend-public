// Neonfi backend — Overview module service (retrofit-13).
//
// The Overview module owns NO tables (composition module, like analytics). It builds
// the dashboard's cross-portfolio aggregate in a single round-trip, reading every
// other module ONLY through that module's public service/repo surface (module
// isolation, mirroring analytics.service.ts):
//   - per-portfolio derived value/PnL ← portfolios/derive.ts (computeDerived)
//   - the user's portfolios            ← portfolios.repository (findPortfoliosByUserId)
//   - assets (allocation/holdings)     ← assets.repository (findAllAssetsByPortfolioId)
//   - snapshots (value-history chart)  ← snapshots.service (findAllSnapshotsAscByPortfolio)
//   - recent txs + count               ← transactions.service (cross-portfolio wrappers)
//
// Wrapped in a per-user Redis cache (key `overview:<userId>:<days>:<txLimit>`, 60s TTL —
// shorter than analytics' 300s since the payload spans tx writes). Full invalidation
// wiring (evict on tx/asset/snapshot writes) is a follow-up; the short TTL bounds
// staleness for the MVP.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getLivePriceMap } from '../../lib/live-price.js';
import { computeDerived } from '../portfolios/derive.js';
import { findPortfoliosByUserId } from '../portfolios/portfolios.repository.js';
import { slugify } from '../portfolios/slug.js';
import { findAllAssetsByPortfolioId } from '../assets/assets.repository.js';
import {
  findAllSnapshotsAscByPortfolio,
  findSnapshotNearDaysAgo,
} from '../snapshots/snapshots.service.js';
import {
  listRecentUserTransactions,
  countUserTransactions,
} from '../transactions/transactions.service.js';
import type { OverviewDTO } from './overview.dto.js';

const CACHE_TTL_S = 60;

// A user is unlikely to exceed a handful of portfolios (plan caps gate the count); pull
// them all in one page so the aggregate is complete. Far above any realistic count.
const PORTFOLIO_FETCH_LIMIT = 1000;

// retrofit-18: top-movers cache. Global (not per-user), so one shared key — TTL matches
// CACHE_TTL_S (60s). Capped at the 6 biggest movers by absolute 24h change.
const TOP_MOVERS_KEY = 'overview_top_movers';
const TOP_MOVERS_LIMIT = 6;

export interface OverviewParams {
  days: number;
  txLimit: number;
}

/**
 * Round a derived float to a fixed wire scale (2dp). Same convention as
 * analytics.service.ts:38 — JS-float derivations carry representation noise and the
 * frontend wants clean numbers to format.
 */
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Mirrors analytics.service.ts's GET/parse/recompute pattern: a Redis miss or malformed
// payload falls through to a fresh compute; a SET failure logs but never blocks the read.
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
    .catch((e: Error) => console.error(`[overview] cache set failed for ${key}:`, e.message));
  return result;
}

// The per-user aggregate, sans `topMovers` — that field is merged in by getOverview from
// its own global cache (see below), so the per-user cache never freezes a movers list.
type OverviewAggregate = Omit<OverviewDTO, 'topMovers'>;

function emptyOverview(): OverviewAggregate {
  return {
    totals: {
      totalValue: 0,
      pnl24h: 0,
      pnl24hValue: 0,
      pnlAllTime: 0,
      pnlAllTimeValue: 0,
      unrealizedPnlValue: 0,
      unrealizedPnlPct: 0,
      realizedPnlValue: 0,
      allTimePnlValue: 0,
      portfolioCount: 0,
      transactionCount: 0,
    },
    portfolios: [],
    valueHistory: [],
    allocation: [],
    holdings: [],
    recentTransactions: [],
  };
}

export async function getOverview(userId: number, params: OverviewParams): Promise<OverviewDTO> {
  // Two independent caches, fetched in parallel: the per-user aggregate
  // (`overview:<userId>:…`) and the global movers list (`overview_top_movers`). Keeping
  // topMovers OUTSIDE the per-user cache means a fresh 24h tick surfaces for every user
  // within the movers' own 60s window instead of being baked into each user's payload.
  const [aggregate, topMovers] = await Promise.all([
    withCache(`overview:${userId}:${params.days}:${params.txLimit}`, () =>
      buildOverview(userId, params),
    ),
    getTopMovers(),
  ]);
  return { ...aggregate, topMovers };
}

// ---- top movers (global, retrofit-18) ----------------------------------------------
// movers = catalog tokens that currently have a live canonical `price:<SYMBOL>` tick
// (written EX 60 by the resolver, retrofit-16), ranked by |change24h|. Cached globally
// for 60s via withCache so it's computed once per window, not per user/request.
function getTopMovers(): Promise<OverviewDTO['topMovers']> {
  return withCache(TOP_MOVERS_KEY, computeTopMovers);
}

async function computeTopMovers(): Promise<OverviewDTO['topMovers']> {
  // The Token table IS the shared price catalog (the live-price overlay reads it too), so
  // pulling symbol→name here is the same surface, not another business module's state.
  const tokens = await prisma.token.findMany({ select: { symbol: true, name: true } });
  if (tokens.length === 0) return [];

  let raw: Array<string | null>;
  try {
    raw = await redis.mget(...tokens.map((t) => `price:${t.symbol}`));
  } catch {
    return []; // feeds/Redis down → empty state (frontend shows its placeholder), never an error
  }

  // Working list — the final `spark` is attached after the top-6 cut (below), so this
  // intermediate shape omits it.
  const movers: Array<{ symbol: string; name: string; change24h: number }> = [];
  tokens.forEach((t, i) => {
    const v = raw[i];
    if (!v) return; // no fresh tick for this symbol
    let change24h: unknown;
    try {
      ({ change24h } = JSON.parse(v) as { change24h?: unknown });
    } catch {
      return; // malformed payload — skip
    }
    if (typeof change24h !== 'number' || !Number.isFinite(change24h)) return;
    movers.push({ symbol: t.symbol, name: t.name, change24h });
  });

  // Biggest movers in EITHER direction: sort by |change| desc, take top 6. Sort on the
  // raw value (like allocation), round only the wire output to 2dp.
  const top = movers
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, TOP_MOVERS_LIMIT);

  // retrofit-20: attach a real recent price series (`spark`) per chosen mover from the
  // sampled `price_hist:<SYMBOL>` list (resolver-written, ≥5-min samples, ≤12 points,
  // stored newest→oldest). Reverse to oldest→newest for the chart; no history / Redis
  // miss → [] (the frontend draws a flat line until ≥2 points accrue). ≤6 small LRANGEs.
  const sparks = await Promise.all(
    top.map((m) =>
      redis
        .lrange(`price_hist:${m.symbol}`, 0, -1)
        .then((rawHist) => rawHist.map(Number).filter(Number.isFinite).reverse())
        .catch(() => [] as number[]),
    ),
  );

  return top.map((m, i) => ({
    symbol: m.symbol,
    name: m.name,
    change24h: round(m.change24h),
    spark: sparks[i]!,
  }));
}

async function buildOverview(
  userId: number,
  { days, txLimit }: OverviewParams,
): Promise<OverviewAggregate> {
  // 1. Portfolios. Zero portfolios → an all-empty payload (NOT a 404): a brand-new
  //    user still loads the dashboard.
  const { portfolios } = await findPortfoliosByUserId(userId, {
    limit: PORTFOLIO_FETCH_LIMIT,
    offset: 0,
  });
  if (portfolios.length === 0) {
    return emptyOverview();
  }

  // 2-5. Fetch per-portfolio derived numbers, assets, and snapshots in parallel, plus
  //      the cross-portfolio recent txs + count. derive.ts is already Redis-cached.
  const [
    derivedList,
    assetsList,
    snapshotsList,
    recentTransactions,
    transactionCount,
    snaps24hAgo,
  ] = await Promise.all([
    Promise.all(portfolios.map((p) => computeDerived(p.id))),
    Promise.all(portfolios.map((p) => findAllAssetsByPortfolioId(p.id))),
    Promise.all(portfolios.map((p) => findAllSnapshotsAscByPortfolio(p.id))),
    listRecentUserTransactions(userId, txLimit),
    countUserTransactions(userId),
    // retrofit-20: the most recent snapshot per portfolio dated ≤ now−24h (daysAgo=1,
    // i.e. the last daily close) — the same source/read the Stage-14 analytics summary
    // uses (findSnapshotNearDaysAgo), so the 24h baseline stays module-isolated.
    Promise.all(portfolios.map((p) => findSnapshotNearDaysAgo(p.id, 1))),
  ]);

  // ---- totals (sum the value fields, recompute aggregate %s) ----
  let totalValue = 0;
  let pnlAllTimeValue = 0;
  // retrofit-27 average-cost aggregate. unrealized/realized sum the per-portfolio derived
  // values; the %-base Σ(costBasis) is accumulated in the allocation loop below (it already
  // iterates every asset, and each asset row carries costBasis).
  let unrealizedPnlValue = 0;
  let realizedPnlValue = 0;
  for (const d of derivedList) {
    totalValue += d.totalValue;
    pnlAllTimeValue += d.pnlAllTimeValue;
    unrealizedPnlValue += d.unrealizedPnlValue;
    realizedPnlValue += d.realizedPnlValue;
  }
  // Guard divide-by-zero → 0 (never NaN/Infinity), mirroring computePnlPeriod.
  const costBasisAll = totalValue - pnlAllTimeValue;
  const pnlAllTime = costBasisAll === 0 ? 0 : (pnlAllTimeValue / costBasisAll) * 100;
  const allTimePnlValue = unrealizedPnlValue + realizedPnlValue;

  // ---- 24h PnL from the daily snapshot history (retrofit-20) ----
  // derive.ts can't compute 24h without history, so it hardcodes pnl24h*=0. Recompute
  // the TOTALS here from BalanceSnapshot: sum each portfolio's most recent snapshot
  // dated ≤ now−24h → value24hAgo, then pnl24hValue = current total − value24hAgo and
  // pnl24h = that over the 24h-ago base. If NO portfolio has a snapshot ≥24h old (a
  // brand-new account) leave 0/0 — the frontend shows +$0.00. Per-portfolio rows keep
  // derive's 0 here (out of scope, same as pnl7d/pnl30d).
  let value24hAgo = 0;
  let has24hBaseline = false;
  for (const s of snaps24hAgo) {
    if (!s) continue;
    value24hAgo += Number(s.value.toString());
    has24hBaseline = true;
  }
  const pnl24hValue = has24hBaseline ? totalValue - value24hAgo : 0;
  const pnl24h = has24hBaseline && value24hAgo > 0 ? (pnl24hValue / value24hAgo) * 100 : 0;

  // ---- per-portfolio rows + allocation/holdings aggregation ----
  // allocation: value (balance × price) summed per symbol; holdings: raw balance summed
  // per symbol (quantity, for the frontend's live-price recalc). grandTotal drives the
  // allocation %s. Only assets with balance > 0 contribute (matches assetCount and the
  // analytics holdings filter).
  const allocValueBySymbol = new Map<string, number>();
  const balanceBySymbol = new Map<string, number>();
  let grandTotal = 0;
  // retrofit-27: Σ(costBasis) across every cost-tracked asset → the unrealized %-base.
  let unrealizedCostBasisSum = 0;

  // retrofit-15: overlay live `price:<SYMBOL>` ticks on the allocation/grandTotal math
  // (the `totals`/per-portfolio totalValue already come from computeDerived, which the
  // derive.ts overlay fixes — don't double-apply there). One mget across every symbol
  // held in any of this user's portfolios; a miss falls back to currentPrice.
  const liveMap = await getLivePriceMap(assetsList.flat().map((a) => a.token.symbol));

  const portfoliosDTO = portfolios.map((p, i) => {
    const d = derivedList[i]!;
    const assets = assetsList[i]!;
    let assetCount = 0;
    for (const a of assets) {
      const balance = Number(a.balance.toString());
      if (balance <= 0) continue;
      assetCount += 1;
      const price = liveMap.get(a.token.symbol) ?? Number(a.token.currentPrice.toString());
      const value = balance * price;
      allocValueBySymbol.set(a.token.symbol, (allocValueBySymbol.get(a.token.symbol) ?? 0) + value);
      balanceBySymbol.set(a.token.symbol, (balanceBySymbol.get(a.token.symbol) ?? 0) + balance);
      grandTotal += value;
      if (a.avgCost !== null) unrealizedCostBasisSum += Number(a.costBasis.toString());
    }
    return {
      id: p.id,
      name: p.name,
      slug: slugify(p.name),
      type: p.type.name as 'connected' | 'manual',
      chainId: p.chainId ?? null,
      chainName: p.chain?.name ?? null,
      assetCount,
      totalValue: round(d.totalValue),
      pnl24h: round(d.pnl24h),
      pnl24hValue: round(d.pnl24hValue),
      pnlAllTime: round(d.pnlAllTime),
      pnlAllTimeValue: round(d.pnlAllTimeValue),
      unrealizedPnlValue: round(d.unrealizedPnlValue),
      unrealizedPnlPct: round(d.unrealizedPnlPct),
      realizedPnlValue: round(d.realizedPnlValue),
      allTimePnlValue: round(d.allTimePnlValue),
    };
  });

  // retrofit-27: aggregate unrealized % over Σ(costBasis) across all the user's assets.
  const unrealizedPnlPct =
    unrealizedCostBasisSum !== 0 ? (unrealizedPnlValue / unrealizedCostBasisSum) * 100 : 0;

  // allocation: desc by value, % of grandTotal (guarded), rounded 2dp. Sort on the raw
  // value (like analytics buildHoldings), then round. Drop zero-value symbols (a token
  // held at a 0 price would otherwise be a meaningless 0% donut segment).
  const allocation = [...allocValueBySymbol.entries()]
    .filter(([, value]) => value > 0)
    .map(([symbol, value]) => ({
      symbol,
      value,
      percentage: grandTotal === 0 ? 0 : (value / grandTotal) * 100,
    }))
    .sort((a, b) => b.value - a.value)
    .map((a) => ({ symbol: a.symbol, value: round(a.value), percentage: round(a.percentage) }));

  // holdings: aggregate balance per symbol (raw quantity). Sorted by symbol for a stable
  // wire order — the frontend keys by symbol, not position.
  const holdings = [...balanceBySymbol.entries()]
    .map(([symbol, balance]) => ({ symbol, balance }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  // ---- value history (aggregate chart, forward-filled) ----
  const valueHistory = buildValueHistory(snapshotsList, days);

  return {
    totals: {
      totalValue: round(totalValue),
      pnl24h: round(pnl24h),
      pnl24hValue: round(pnl24hValue),
      pnlAllTime: round(pnlAllTime),
      pnlAllTimeValue: round(pnlAllTimeValue),
      unrealizedPnlValue: round(unrealizedPnlValue),
      unrealizedPnlPct: round(unrealizedPnlPct),
      realizedPnlValue: round(realizedPnlValue),
      allTimePnlValue: round(allTimePnlValue),
      portfolioCount: portfolios.length,
      transactionCount,
    },
    portfolios: portfoliosDTO,
    valueHistory,
    allocation,
    holdings,
    recentTransactions,
  };
}

// Aggregate per-portfolio snapshot series into one chart series. For each kept date,
// sum each portfolio's most recent snapshot value ON OR BEFORE that date (forward-fill);
// a portfolio with no snapshot yet contributes 0. This keeps the total from dipping when
// a newer portfolio simply has fewer points than an older one.
function buildValueHistory(
  snapshotsList: Array<Array<{ snapshotDate: Date; value: { toString(): string } }>>,
  days: number,
): Array<{ date: string; value: number }> {
  // Per-portfolio [date, value] arrays, ASC by date (the repo already orders ASC).
  const series = snapshotsList.map((snaps) =>
    snaps.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: Number(s.value.toString()),
    })),
  );

  const allDates = new Set<string>();
  for (const s of series) {
    for (const point of s) allDates.add(point.date);
  }
  if (allDates.size === 0) return [];

  // YYYY-MM-DD sorts lexicographically == chronologically. Keep only the last `days`.
  const keptDates = [...allDates].sort().slice(-days);

  return keptDates.map((date) => {
    let sum = 0;
    for (const s of series) {
      // Most recent value on/before `date`. Series is ASC, so the last point with
      // point.date <= date wins; once we pass `date` we can stop.
      let v = 0;
      for (const point of s) {
        if (point.date <= date) v = point.value;
        else break;
      }
      sum += v;
    }
    return { date, value: round(sum) };
  });
}
