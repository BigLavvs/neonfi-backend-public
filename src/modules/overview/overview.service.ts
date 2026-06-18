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
import { computeDerived } from '../portfolios/derive.js';
import { findPortfoliosByUserId } from '../portfolios/portfolios.repository.js';
import { slugify } from '../portfolios/slug.js';
import { findAllAssetsByPortfolioId } from '../assets/assets.repository.js';
import type { AssetWithToken } from '../assets/assets.dto.js';
import { findSnapshotNearDaysAgo } from '../snapshots/snapshots.service.js';
import {
  listRecentUserTransactions,
  countUserTransactions,
} from '../transactions/transactions.service.js';
import {
  findUserTokenTxEvents,
  type TokenTxEvent,
} from '../transactions/transactions.repository.js';
import { findBulkTokenPriceSnapshotsSince } from '../tokens/tokens.repository.js';
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
    markers: [],
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

  // 2-5. Fetch per-portfolio derived numbers, assets, and cross-portfolio data in parallel.
  //      retrofit-45: snapshotsList/findAllSnapshotsAscByPortfolio replaced by tx events
  //      + bulk price history for the transaction-aware reconstruction. Price snapshots
  //      need tokenIds from assetsList, so they run in a second sequential step below.
  const [
    derivedList,
    assetsList,
    txEvents,
    recentTransactions,
    transactionCount,
    snaps24hAgo,
  ] = await Promise.all([
    Promise.all(portfolios.map((p) => computeDerived(p.id))),
    Promise.all(portfolios.map((p) => findAllAssetsByPortfolioId(p.id))),
    findUserTokenTxEvents(userId),
    listRecentUserTransactions(userId, txLimit),
    countUserTransactions(userId),
    // retrofit-20: the most recent snapshot per portfolio dated ≤ now−24h (daysAgo=1,
    // i.e. the last daily close) — the same source/read the Stage-14 analytics summary
    // uses (findSnapshotNearDaysAgo), so the 24h baseline stays module-isolated.
    Promise.all(portfolios.map((p) => findSnapshotNearDaysAgo(p.id, 1))),
  ]);

  // Build the `days`-length UTC date axis (oldest→newest) and fetch TokenPriceSnapshots
  // for all held tokens starting from the first day in the axis.
  const allAssets = assetsList.flat();
  const tokenIds = [...new Set(allAssets.map((a) => a.tokenId))];
  const now = new Date();
  const axis: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().slice(0, 10));
  }
  const rangeStart = new Date(`${axis[0]!}T00:00:00.000Z`);
  const priceSnapRows = await findBulkTokenPriceSnapshotsSince(tokenIds, rangeStart);

  // priceByToken: Map<tokenId, sorted ASC list of {ymd, price}> — from the bulk query.
  const priceByToken = new Map<number, Array<{ ymd: string; price: number }>>();
  for (const row of priceSnapRows) {
    const ymd = row.snapshotDate.toISOString().slice(0, 10);
    const list = priceByToken.get(row.tokenId) ?? [];
    list.push({ ymd, price: row.price });
    priceByToken.set(row.tokenId, list);
  }
  // currentPriceByToken: fallback when no snapshot exists for a day.
  const currentPriceByToken = new Map<number, number>();
  for (const a of allAssets) {
    currentPriceByToken.set(a.tokenId, Number(a.token.currentPrice.toString()));
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
  // retrofit-28: the per-request live-price overlay (getLivePriceMap) is removed from this
  // read path — allocation/holdings now return the daily/stored currentPrice and the
  // client owns the live overlay (it recomputes from the firehose × balance/avgCost with
  // this daily fallback). NOTE: totals/per-portfolio totalValue still come from
  // computeDerived, which keeps its own overlay (out of scope here, and test 390 asserts
  // the live total) — so totals stay live while allocation is the daily fallback.
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
    let assetCount = 0;
    // retrofit-28: raw per-portfolio holdings (balance > 0 only), for client recompute.
    const holdings: OverviewDTO['portfolios'][number]['holdings'] = [];
    for (const a of assets) {
      const balance = Number(a.balance.toString());
      if (balance <= 0) continue;
      assetCount += 1;
      const symbol = a.token.symbol;
      const price = Number(a.token.currentPrice.toString());
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

  // ---- value history + markers (transaction-aware reconstruction, retrofit-45) ----
  const valueHistory = buildReconstructedValueHistory(
    allAssets, txEvents, priceByToken, currentPriceByToken, axis,
  );
  const markers = buildTransactionMarkers(
    allAssets, txEvents, priceByToken, currentPriceByToken, rangeStart,
  );

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
    markers,
  };
}

// ---- Value history + marker helpers (retrofit-45) ----------------------------------
//
// Both builders share the same per-token running-balance walk: opening lots seed the
// starting balance; sorted buy/sell events advance it chronologically. The price at any
// given UTC calendar day is the most recent TokenPriceSnapshot on/before that day (or
// Token.currentPrice when no snapshot exists). Walk is O(events + days) per token via
// advancing cursors (never restarting per day).

type PriceMap = Map<number, Array<{ ymd: string; price: number }>>;
type CurrPriceMap = Map<number, number>;

function buildOpeningByToken(allAssets: AssetWithToken[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of allAssets) {
    m.set(a.tokenId, (m.get(a.tokenId) ?? 0) + Number(a.openingBalance.toString()));
  }
  return m;
}

function buildSymbolToTokenId(allAssets: AssetWithToken[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of allAssets) m.set(a.token.symbol, a.tokenId);
  return m;
}

// Look up the most recent snapshot price on/before `ymd`. `list` is sorted ASC.
function priceAt(list: Array<{ ymd: string; price: number }>, ymd: string, fallback: number): number {
  let p: number | undefined;
  for (const snap of list) {
    if (snap.ymd <= ymd) p = snap.price;
    else break;
  }
  return p ?? fallback;
}

function buildReconstructedValueHistory(
  allAssets: AssetWithToken[],
  events: TokenTxEvent[],
  priceByToken: PriceMap,
  currentPriceByToken: CurrPriceMap,
  axis: string[],
): Array<{ date: string; value: number }> {
  if (axis.length === 0 || allAssets.length === 0) return [];

  const openingByToken = buildOpeningByToken(allAssets);
  const symbolToTokenId = buildSymbolToTokenId(allAssets);
  const allTokenIds = [...openingByToken.keys()];
  if (allTokenIds.length === 0) return [];

  // Group events by tokenId (events already sorted ASC by query).
  const eventsByToken = new Map<number, TokenTxEvent[]>();
  for (const e of events) {
    const tokenId = symbolToTokenId.get(e.symbol);
    if (tokenId === undefined) continue;
    const list = eventsByToken.get(tokenId) ?? [];
    list.push(e);
    eventsByToken.set(tokenId, list);
  }

  // Per-token advancing cursors (O(events + days) total).
  const balCursors = new Map(allTokenIds.map((id) => [id, openingByToken.get(id) ?? 0]));
  const evtCursors = new Map(allTokenIds.map((id) => [id, 0]));
  const pricePtrs = new Map(allTokenIds.map((id) => [id, 0]));

  const result: Array<{ date: string; value: number }> = [];

  for (const day of axis) {
    // Advance price pointers: keep ptr pointing past last snapshot ≤ day.
    for (const tokenId of allTokenIds) {
      const list = priceByToken.get(tokenId) ?? [];
      let ptr = pricePtrs.get(tokenId) ?? 0;
      while (ptr < list.length && list[ptr]!.ymd <= day) ptr++;
      pricePtrs.set(tokenId, ptr);
    }

    // Apply all events whose UTC date is on/before this day.
    for (const tokenId of allTokenIds) {
      const evts = eventsByToken.get(tokenId);
      if (!evts) continue;
      let idx = evtCursors.get(tokenId) ?? 0;
      let bal = balCursors.get(tokenId) ?? 0;
      while (idx < evts.length && evts[idx]!.ts.toISOString().slice(0, 10) <= day) {
        const e = evts[idx]!;
        bal += e.dir === 'buy' ? e.amount : -e.amount;
        idx++;
      }
      evtCursors.set(tokenId, idx);
      balCursors.set(tokenId, bal);
    }

    let dayValue = 0;
    for (const tokenId of allTokenIds) {
      const bal = balCursors.get(tokenId) ?? 0;
      const list = priceByToken.get(tokenId) ?? [];
      const ptr = pricePtrs.get(tokenId) ?? 0;
      const price = ptr > 0 ? list[ptr - 1]!.price : (currentPriceByToken.get(tokenId) ?? 0);
      dayValue += bal * price;
    }
    result.push({ date: day, value: round(dayValue) });
  }

  return result;
}

function buildTransactionMarkers(
  allAssets: AssetWithToken[],
  events: TokenTxEvent[],
  priceByToken: PriceMap,
  currentPriceByToken: CurrPriceMap,
  rangeStart: Date,
): OverviewDTO['markers'] {
  if (allAssets.length === 0) return [];

  const openingByToken = buildOpeningByToken(allAssets);
  const symbolToTokenId = buildSymbolToTokenId(allAssets);
  const allTokenIds = [...openingByToken.keys()];

  const balCursors = new Map(allTokenIds.map((id) => [id, openingByToken.get(id) ?? 0]));
  const rangeStartYmd = rangeStart.toISOString().slice(0, 10);

  const markers: OverviewDTO['markers'] = [];

  for (const e of events) {
    const tokenId = symbolToTokenId.get(e.symbol);
    if (tokenId === undefined) continue;

    // Always advance the running balance (even pre-range events affect later values).
    const cur = balCursors.get(tokenId) ?? 0;
    balCursors.set(tokenId, e.dir === 'buy' ? cur + e.amount : cur - e.amount);

    const eventYmd = e.ts.toISOString().slice(0, 10);
    // Emit marker only for in-range, non-transfer-leg events.
    if (eventYmd < rangeStartYmd || e.transferGroupId !== null) continue;

    // valueAfter: Σ(balance × price at eventYmd) right after this event.
    let valueAfter = 0;
    for (const tid of allTokenIds) {
      const fallback = currentPriceByToken.get(tid) ?? 0;
      const price = priceAt(priceByToken.get(tid) ?? [], eventYmd, fallback);
      valueAfter += (balCursors.get(tid) ?? 0) * price;
    }

    markers.push({
      timestamp: e.ts.toISOString(),
      direction: e.dir,
      symbol: e.symbol,
      usdValue: e.usdValue,
      valueAfter: round(valueAfter),
    });
  }

  // Cap to 500 newest, return newest-first.
  return markers.slice(-500).reverse();
}
