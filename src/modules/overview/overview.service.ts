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
  countUserTransactionsByPortfolio,
  earliestUserTransactionDate,
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
  // retrofit-50: optional whitelist of the user's portfolio ids to scope the aggregate to
  // (the Performance page's portfolio selector). undefined = all of the user's portfolios.
  portfolioIds?: number[];
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
    connectedValueHistory: [],
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
  // retrofit-50: the portfolio filter is part of the cache identity — a filtered request
  // must not read (or poison) the all-portfolios payload. Normalize the ids (sorted, '.'
  // -joined) so {1,2} and {2,1} share a key; 'all' when unfiltered.
  const idsKey = params.portfolioIds ? [...params.portfolioIds].sort((a, b) => a - b).join('.') : 'all';
  const [aggregate, topMovers] = await Promise.all([
    withCache(`overview:${userId}:${params.days}:${params.txLimit}:${idsKey}`, () =>
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

  // retrofit-20/43: attach a real recent price series (`spark`) per chosen mover from the
  // sampled `price_hist:<SYMBOL>` list (resolver-written, ≥3-min samples, ≤480 points,
  // stored newest→oldest). Reverse to oldest→newest for the chart; no history / Redis
  // miss → [] (the frontend draws a flat line until ≥2 points accrue). ≤6 small LRANGEs.
  //
  // retrofit-43: entries are now "<ts>|<price>" (were bare prices pre-43). Take the price
  // half; fall back to parsing the whole token so any legacy entries still within TTL render.
  const parsePrice = (s: string): number => {
    const bar = s.indexOf('|');
    return Number(bar >= 0 ? s.slice(bar + 1) : s);
  };
  const sparks = await Promise.all(
    top.map((m) =>
      redis
        .lrange(`price_hist:${m.symbol}`, 0, -1)
        .then((rawHist) => rawHist.map(parsePrice).filter(Number.isFinite).reverse())
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
  { days, txLimit, portfolioIds }: OverviewParams,
): Promise<OverviewAggregate> {
  // 1. Portfolios. Zero portfolios → an all-empty payload (NOT a 404): a brand-new
  //    user still loads the dashboard. retrofit-50: when a portfolio filter is set, the
  //    id whitelist scopes this read (and therefore every per-portfolio derive/asset/
  //    snapshot/count below, which all map over `portfolios`); foreign ids drop out.
  const { portfolios } = await findPortfoliosByUserId(userId, {
    limit: PORTFOLIO_FETCH_LIMIT,
    offset: 0,
    ids: portfolioIds,
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
    dbTxCountByPortfolio,
    snaps24hAgo,
    earliestTxDates,
  ] = await Promise.all([
    Promise.all(portfolios.map((p) => computeDerived(p.id))),
    Promise.all(portfolios.map((p) => findAllAssetsByPortfolioId(p.id))),
    Promise.all(portfolios.map((p) => findAllSnapshotsAscByPortfolio(p.id))),
    // retrofit-50: scope the recent-tx list to the selected portfolios when filtering.
    listRecentUserTransactions(userId, txLimit, portfolioIds),
    // retrofit-49 (#8): per-portfolio DB tx counts. A connected portfolio shows its REAL
    // on-chain total (externalTxCount) even though only ~100 rows are imported; manual +
    // connected-without-a-provider-total fall back to the imported DB row count.
    countUserTransactionsByPortfolio(userId),
    // retrofit-20: the most recent snapshot per portfolio dated ≤ now−24h (daysAgo=1,
    // i.e. the last daily close) — the same source/read the Stage-14 analytics summary
    // uses (findSnapshotNearDaysAgo), so the 24h baseline stays module-isolated.
    Promise.all(portfolios.map((p) => findSnapshotNearDaysAgo(p.id, 1))),
    // retrofit-66: earliest logged-tx timestamp per portfolio → inceptionDate (below).
    Promise.all(portfolios.map((p) => earliestUserTransactionDate(p.id))),
  ]);

  // retrofit-70 (C2/C3/M20): value allocation off the SAME live price as totalValue. derive.ts
  // already overlays the live `price:<SYM>` tick when computing each portfolio's totalValue, so
  // valuing allocation/grandTotal off `Token.currentPrice` (stale until the 6-hourly CMC sync)
  // made the donut slices not sum to the headline and the dashboard total flip across loads. One
  // map for every symbol across every portfolio → allocation reconciles with totals.totalValue.
  const allSymbols = assetsList.flat().map((a) => a.token.symbol);
  const liveMap = await getLivePriceMap(allSymbols);

  // retrofit-74 (§1, reverts retrofit-73 H10): the headline "Transactions" is the wallet's REAL
  // total — a connected portfolio shows its provider-reported on-chain total (externalTxCount,
  // resolved at sync time by resolveExternalTxCount) and a manual portfolio shows its DB row
  // count. The H10 split (imported-rows headline + a separate onChainTransactionCount) understated
  // real activity (17 vs ~420) and is dropped: one honest number, no dual count. The table is
  // paginated (load-more, Pro) so the list can reach the rest. Dedupe externalTxCount by wallet
  // address so the SAME wallet connected in two portfolios isn't double-counted (each reports the
  // same on-chain total). Manual / connected-without-a-provider-total fall back to the DB rows.
  let transactionCount = 0;
  const countedWallets = new Set<string>();
  for (const p of portfolios) {
    if (p.type.name === 'connected' && p.externalTxCount != null) {
      const walletKey = (p.walletAddress ?? '').toLowerCase();
      if (walletKey && countedWallets.has(walletKey)) continue; // same wallet already counted
      if (walletKey) countedWallets.add(walletKey);
      transactionCount += p.externalTxCount;
    } else {
      transactionCount += dbTxCountByPortfolio.get(p.id) ?? 0;
    }
  }

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
  // allocation: value (balance × price) summed per symbol; holdings: raw position data
  // (balance + cost basis) summed per symbol, for the frontend's live-price recompute.
  // grandTotal drives the allocation %s. Only assets with balance > 0 contribute (matches
  // assetCount and the analytics holdings filter).
  //
  // retrofit-70 (C2/C3/M20): allocation is valued off the live map (`liveMap.get(sym) ??
  // currentPrice`) — the SAME price derive.ts uses for totalValue — so Σ(allocation.value)
  // reconciles with the headline totalValue and the donut % matches every other surface.
  // (retrofit-28 had dropped this overlay so allocation returned the stale daily currentPrice
  // while totals stayed live, which made the slices not sum to the total and the net-worth
  // flicker across loads.) The client firehose still refines between 60s cache windows.
  const allocValueBySymbol = new Map<string, number>();
  const balanceBySymbol = new Map<string, number>();
  // retrofit-28 aggregate cost accumulators (per symbol, cost-tracked = avgCost != null):
  const costBasisBySymbol = new Map<string, number>(); // Σ Asset.costBasis
  const realizedPnlBySymbol = new Map<string, number>(); // Σ Asset.realizedPnl
  const avgCostNumeratorBySymbol = new Map<string, number>(); // Σ avgCost × balance
  const costTrackedQtyBySymbol = new Map<string, number>(); // Σ balance over cost-tracked
  let grandTotal = 0;
  // retrofit-27: Σ(costBasis) across every cost-tracked asset → the unrealized %-base.
  let unrealizedCostBasisSum = 0;

  const portfoliosDTO = portfolios.map((p, i) => {
    const d = derivedList[i]!;
    const assets = assetsList[i]!;
    // retrofit-66: inceptionDate = min(createdAt, earliest logged-tx timestamp). A backdated
    // transaction legitimately starts the line earlier; otherwise it's createdAt. The frontend
    // uses it to clamp the MANUAL value-history reconstruction so a brand-new manual portfolio's
    // chart can't pre-date the portfolio. (Connected charts use recorded snapshots and ignore it.)
    const earliestTx = earliestTxDates[i] ?? null;
    const inception = earliestTx !== null && earliestTx < p.createdAt ? earliestTx : p.createdAt;
    let assetCount = 0;
    // retrofit-28: raw per-portfolio holdings (balance > 0 only), for client recompute.
    const holdings: OverviewDTO['portfolios'][number]['holdings'] = [];
    for (const a of assets) {
      const balance = Number(a.balance.toString());
      if (balance <= 0) continue;
      assetCount += 1;
      const symbol = a.token.symbol;
      const price = liveMap.get(symbol) ?? Number(a.token.currentPrice.toString());
      const value = balance * price;
      allocValueBySymbol.set(symbol, (allocValueBySymbol.get(symbol) ?? 0) + value);
      balanceBySymbol.set(symbol, (balanceBySymbol.get(symbol) ?? 0) + balance);
      grandTotal += value;

      // retrofit-28: cost fields straight off the Asset (maintained by recalc). avgCost is
      // null for cost-unknown holdings. Full precision — these feed the client's recompute.
      const avgCost = a.avgCost !== null ? Number(a.avgCost.toString()) : null;
      const costBasis = Number(a.costBasis.toString());
      const realizedPnl = Number(a.realizedPnl.toString());
      holdings.push({ symbol, balance, avgCost, costBasis, realizedPnl });

      costBasisBySymbol.set(symbol, (costBasisBySymbol.get(symbol) ?? 0) + costBasis);
      realizedPnlBySymbol.set(symbol, (realizedPnlBySymbol.get(symbol) ?? 0) + realizedPnl);
      if (avgCost !== null) {
        avgCostNumeratorBySymbol.set(
          symbol,
          (avgCostNumeratorBySymbol.get(symbol) ?? 0) + avgCost * balance,
        );
        costTrackedQtyBySymbol.set(symbol, (costTrackedQtyBySymbol.get(symbol) ?? 0) + balance);
        unrealizedCostBasisSum += costBasis;
      }
    }
    return {
      id: p.id,
      name: p.name,
      slug: slugify(p.name),
      type: p.type.name as 'connected' | 'manual',
      chainId: p.chainId ?? null,
      chainName: p.chain?.name ?? null,
      inceptionDate: inception.toISOString(), // retrofit-66
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
      holdings,
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

  // holdings: aggregate per symbol (raw quantity + summed cost basis). avgCost is the
  // balance-weighted average over cost-tracked assets (Σ(avgCost×balance)/Σ(balance)),
  // null when no portfolio tracks cost for that symbol. Sorted by symbol for a stable
  // wire order — the frontend keys by symbol, not position. retrofit-28.
  const holdings = [...balanceBySymbol.entries()]
    .map(([symbol, balance]) => {
      const trackedQty = costTrackedQtyBySymbol.get(symbol) ?? 0;
      const avgCost =
        trackedQty > 0 ? (avgCostNumeratorBySymbol.get(symbol) ?? 0) / trackedQty : null;
      return {
        symbol,
        balance,
        avgCost,
        costBasis: costBasisBySymbol.get(symbol) ?? 0,
        realizedPnl: realizedPnlBySymbol.get(symbol) ?? 0,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  // ---- value history (aggregate chart, forward-filled) ----
  const valueHistory = buildValueHistory(snapshotsList, days);
  // retrofit-56: a connected-only slice of the SAME recorded snapshot series. The frontend
  // reconstructs the MANUAL portion from per-portfolio holdings × transactions (unchanged)
  // and adds this recorded connected portion — connected wallets no longer go through the
  // (wrong-for-windowed-imports) frontend reconstruction. `snapshotsList` is parallel to
  // `portfolios`, so filter by the matching portfolio's type.
  const connectedSnapshotsList = snapshotsList.filter(
    (_, i) => portfolios[i]!.type.name === 'connected',
  );
  const connectedValueHistory = buildValueHistory(connectedSnapshotsList, days);

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
    connectedValueHistory,
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

  const points = keptDates.map((date) => {
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

  // retrofit-67: trim the leading run of $0 points so already-persisted pre-funding zero
  // snapshots stop charting as a flat tail (no fresh resync needed). On the aggregate series
  // leading zeros only occur before ANY selected portfolio held value, so this is correct
  // there too; interior zeros are preserved; an all-zero series returns [].
  const firstNonZero = points.findIndex((p) => p.value > 0);
  if (firstNonZero === -1) return [];
  return firstNonZero === 0 ? points : points.slice(firstNonZero);
}
