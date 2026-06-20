// Derived portfolio fields — current-state PnL computed from live Asset balances
// and the maintained Portfolio.netDeposit.
//
// What derive.ts OWNS: totalValue, pnlAllTime, pnlAllTimeValue (cost-basis PnL
// against Portfolio.netDeposit, maintained by retrofit-2).
//
// retrofit-76: derive.ts ALSO owns 24h/7d/30d PnL for MANUAL portfolios now. The old
// "snapshots belong to analytics, stay 0 here" rule is superseded — derive already reads
// BalanceSnapshot for connected (retrofit-58), so we extend the same windowed-delta read to
// manual: pnl24h/7d/30d = currentValue − findSnapshotNearDaysAgo(id, N) (retrofit-72 H5
// tolerance; no snapshot in window → 0/0). The cost-basis ALL-TIME path is unchanged — only
// the short-term windows are added. This makes the overview TOTALS 24h (which already sums the
// snapshot delta for every portfolio with a ~24h-old snapshot, manual included) equal Σ of the
// per-portfolio 24h rows, and lets a manual portfolio display its own 24h/7d/30d once it has a
// day of history.
//
// retrofit-79 (§1c/§4): CONNECTED portfolios now get REAL cost basis from a provider PnL
// endpoint (GoldRush → Moralis, written into Asset.avgCost/costBasis/realizedPnl by
// wallet-data/sync.ts), so they use the SAME cost-basis all-time path manual uses
// (allTimePnlValue = unrealized + realized). This SUPERSEDES retrofit-58's snapshot-delta
// all-time, which conflated withdrawals with losses (the fake −96%). A connected wallet with NO
// cost basis (provider denied / unsupported chain / no trades) returns all-time = null → the UI
// shows "—", never a fabricated number. Short-term 24h/7d/30d still come from BalanceSnapshot
// deltas for both types — now null when there's no approx=false baseline (§2/D1).
//
// Redis cache (retrofit-3 §1.5): key `portfolio_pnl:<portfolioId>`, 5-min TTL.
// Invalidated on transaction CUD (retrofit-2, transactions.service.ts) and on
// snapshot write (retrofit-3, snapshot.job.ts). A Redis failure never blocks the
// read — every cache call is `.catch`-guarded and falls through to DB compute.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getLivePriceMap } from '../../lib/live-price.js';
import { findSnapshotNearDaysAgo } from '../snapshots/snapshots.service.js';

// retrofit-15: this cache is price-dependent (totalValue tracks live price), so it's
// dropped from 5 min to 60s to match the `price:<SYMBOL>` TTL — "latest at page-load"
// only holds if the cache can't outlive a tick. Reads only; the cost is a little more
// recompute, fine at MVP scale.
const CACHE_TTL_S = 60;

export interface DerivedFields {
  totalValue: number;
  // All-time PnL (the canonical headline number the dashboard + analytics read).
  //   - MANUAL: legacy netDeposit-based (retrofit-2/27 Augment): pnlAllTimeValue = totalValue −
  //     Portfolio.netDeposit. (overview maps its OWN canonical from the cost-basis fields below;
  //     analytics still reads these.)
  //   - CONNECTED with provider cost basis (retrofit-79 §1): the cost-basis all-time
  //     (allTimePnlValue / unrealizedPnlPct) — the SAME path manual uses, not snapshot deltas.
  //   - CONNECTED without cost basis (retrofit-79 §4): null → the UI shows "—", never a
  //     fabricated snapshot-delta number.
  pnlAllTime: number | null;
  pnlAllTimeValue: number | null;
  // retrofit-27: average-cost PnL (the new model). unrealizedPnlValue = Σ over cost-tracked
  // assets of heldQty × (livePrice − avgCost); unrealizedPnlPct = that / Σ(costBasis) × 100
  // (0 with no cost basis); realizedPnlValue = Σ Asset.realizedPnl; allTimePnlValue =
  // unrealized + realized (the single avg-cost headline).
  unrealizedPnlValue: number;
  unrealizedPnlPct: number;
  realizedPnlValue: number;
  allTimePnlValue: number;
  // retrofit-79 (§6): Σ Asset.costBasis over cost-tracked assets — the connected "Total invested"
  // floor (it excludes since-sold lots). 0 when nothing is cost-tracked.
  costBasisTotal: number;
  // retrofit-79 (§2/D1): short-term windows are null (not 0) when there's no in-tolerance
  // approx=false snapshot baseline → the UI shows "—" ("unknown"), distinct from a real flat 0.
  pnl24h: number | null;
  pnl24hValue: number | null;
  pnl7d: number | null;
  pnl7dValue: number | null;
  pnl30d: number | null;
  pnl30dValue: number | null;
}

export async function computeDerived(portfolioId: number): Promise<DerivedFields> {
  // 1. Cache check — a malformed/short payload falls through to recompute.
  const cached = await redis.get(`portfolio_pnl:${portfolioId}`).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DerivedFields;
      // pnlAllTime can legitimately be null (connected w/o cost basis, retrofit-79 §4), so
      // validate on always-numeric fields instead. A pre-retrofit-79 payload lacking
      // costBasisTotal falls through to a one-time recompute (TTL is only 60s).
      if (
        typeof parsed.totalValue === 'number' &&
        typeof parsed.allTimePnlValue === 'number' &&
        typeof parsed.costBasisTotal === 'number'
      ) {
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

  // retrofit-27 average-cost headline: unrealized % over Σ cost basis (guarded), and
  // all-time = unrealized + realized.
  const unrealizedPnlPct = costBasisSum !== 0 ? (unrealizedPnlValue / costBasisSum) * 100 : 0;
  const allTimePnlValue = unrealizedPnlValue + realizedPnlValue;

  // retrofit-76/79: 24h/7d/30d from BalanceSnapshot deltas (now NULL when there's no
  // approx=false baseline — §2/D1). Shared by both portfolio types.
  const shortTerm = await computeShortTermDeltas(portfolioId, totalValue);

  const isConnected = portfolio?.type?.name === 'connected';
  // retrofit-79 (§1): a connected wallet has cost basis when the provider PnL populated any
  // avgCost OR any realized PnL (a fully-sold token has realized but no held units). That's the
  // signal to use the cost-basis path instead of the §4 "—" fallback.
  const hasCostBasis = assets.some((a) => a.avgCost !== null) || realizedPnlValue !== 0;

  if (isConnected && !hasCostBasis) {
    // retrofit-79 (§4): no provider cost basis → all-time is genuinely unknown, NOT a fabricated
    // snapshot-delta. Short-term still comes from snapshots (null when no real baseline).
    return {
      totalValue,
      pnlAllTime: null,
      pnlAllTimeValue: null,
      unrealizedPnlValue: 0,
      unrealizedPnlPct: 0,
      realizedPnlValue: 0,
      allTimePnlValue: 0,
      costBasisTotal: 0,
      ...shortTerm,
    };
  }

  // retrofit-79 (§1c): CONNECTED with cost basis reports the cost-basis all-time VALUE
  // (allTimePnlValue = unrealized + realized). MANUAL keeps the legacy netDeposit-based all-time
  // (retrofit-2/27 Augment), byte-for-byte unchanged.
  let pnlAllTime: number | null;
  let pnlAllTimeValue: number;
  if (isConnected) {
    // retrofit-80: the connected all-time VALUE includes REALIZED PnL (allTimePnlValue =
    // unrealized + realized), but the honest all-time PERCENT needs the LIFETIME cost base — the
    // total ever invested to produce BOTH the realized and the still-held units. A windowed
    // connected import gives us only the cost basis of CURRENTLY-HELD units (costBasis) + realized
    // PnL, never the cost of the since-sold units, so that % is uncomputable from what we store.
    // retrofit-79 §1c wrongly set the % to unrealizedPnlPct (unrealized / current cost basis) while
    // the value carried unrealized + realized — a sign-contradiction (+$1,391 value but −99.72%).
    // Report the VALUE and leave the % null → the UI shows "—", never a fabricated/contradictory
    // percentage. (A future retrofit can light up a real % once a provider lifetime-invested field
    // — Moralis total_usd_invested / a GoldRush upnl total-bought — is probed and persisted
    // alongside the cost basis; the field exists but isn't reliably served by the PRIMARY provider
    // today, and the §0 re-probe was quota-blocked, so we ship the honest "—".)
    pnlAllTimeValue = allTimePnlValue;
    pnlAllTime = null;
  } else {
    const netDeposit = portfolio ? Number(portfolio.netDeposit.toString()) : 0;
    pnlAllTimeValue = totalValue - netDeposit;
    pnlAllTime = netDeposit !== 0 ? (pnlAllTimeValue / netDeposit) * 100 : 0;
  }

  return {
    totalValue,
    pnlAllTime,
    pnlAllTimeValue,
    unrealizedPnlValue,
    unrealizedPnlPct,
    realizedPnlValue,
    allTimePnlValue,
    costBasisTotal: costBasisSum,
    ...shortTerm,
  };
}

// currentValue − a snapshot baseline; % over the baseline (guard divide-by-zero → 0). retrofit-79
// (§2/D1): a NULL baseline (no in-tolerance approx=false snapshot in the window) now yields
// null/null — "unknown", distinct from a real flat 0 — never NaN/Infinity.
function snapshotDelta(
  totalValue: number,
  base: { value: { toString(): string } } | null,
): { value: number | null; pct: number | null } {
  if (!base) return { value: null, pct: null };
  const b = Number(base.value.toString());
  const value = totalValue - b;
  return { value, pct: b !== 0 ? (value / b) * 100 : 0 };
}

// retrofit-76/79: the 24h/7d/30d PnL fields, from recorded BalanceSnapshot deltas —
// currentValue − the snapshot nearest N days ago (findSnapshotNearDaysAgo already filters to
// approx=false + the H5 tolerance; no usable baseline → null/null, §2/D1). Shared by both types.
type ShortTermPnl = Pick<
  DerivedFields,
  'pnl24h' | 'pnl24hValue' | 'pnl7d' | 'pnl7dValue' | 'pnl30d' | 'pnl30dValue'
>;

async function computeShortTermDeltas(
  portfolioId: number,
  totalValue: number,
): Promise<ShortTermPnl> {
  const [snap1, snap7, snap30] = await Promise.all([
    findSnapshotNearDaysAgo(portfolioId, 1),
    findSnapshotNearDaysAgo(portfolioId, 7),
    findSnapshotNearDaysAgo(portfolioId, 30),
  ]);
  const d1 = snapshotDelta(totalValue, snap1);
  const d7 = snapshotDelta(totalValue, snap7);
  const d30 = snapshotDelta(totalValue, snap30);
  return {
    pnl24h: d1.pct,
    pnl24hValue: d1.value,
    pnl7d: d7.pct,
    pnl7dValue: d7.value,
    pnl30d: d30.pct,
    pnl30dValue: d30.value,
  };
}
