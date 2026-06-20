// Neonfi backend — Overview module resource representation (retrofit-13).
//
// The Overview module owns NO tables. It is a composition module (like analytics)
// that aggregates cross-portfolio data into a single dashboard payload. The frontend
// dashboard `(dashboard)/dashboard/+page.ts` consumes this DTO directly and maps it to
// its `{ summary, portfolios, chartPoints/Labels, allocation, holdings,
// recentTransactions }` shape with a thin transform.
//
// All derived floats are rounded to 2dp on the wire (same `round()` convention as
// analytics.service.ts). Raw quantities (holdings.balance) keep full precision — the
// frontend recomputes their live USD value against streaming prices.

import type { TransactionListDTO } from '../transactions/transactions.dto.js';

export interface OverviewDTO {
  totals: {
    totalValue: number; // Σ portfolio.totalValue
    pnl24h: number; // aggregate % (guarded divide-by-zero → 0)
    // retrofit-75 (M16): Σ over the portfolios that actually have a ~24h-old snapshot of
    // (their current value − that snapshot). A portfolio with no 24h baseline is excluded
    // from BOTH sides, so its current value can't read as a phantom 24h gain.
    pnl24hValue: number;
    // retrofit-75 (R39): canonical all-time — Σ of each portfolio's per-type all-time
    // (connected → snapshot-vs-earliest, manual → cost-basis unrealized+realized, which
    // EXCLUDES cost-unknown holdings so a stablecoin-only portfolio nets ~0). pnlAllTime is
    // recomputed over the implied aggregate base (Σ baseline). Replaces the netDeposit-based
    // number, which made a cost-unknown opening read as a phantom gain.
    pnlAllTime: number; // aggregate % (guarded divide-by-zero → 0)
    pnlAllTimeValue: number; // Σ canonical per-portfolio all-time
    // retrofit-27: average-cost PnL aggregate (additive). allTimePnlValue = unrealized +
    // realized; unrealizedPnlPct is over Σ(costBasis) across all the user's assets.
    unrealizedPnlValue: number;
    unrealizedPnlPct: number;
    realizedPnlValue: number;
    allTimePnlValue: number;
    portfolioCount: number;
    // retrofit-74 (§1, reverts retrofit-73 H10): the wallet's REAL transaction total — each
    // connected portfolio's provider-reported on-chain total (externalTxCount, deduped by wallet
    // address) plus each manual portfolio's DB row count. One honest number; the H10 split into a
    // separate onChainTransactionCount is removed. The transaction table is paginated (load-more,
    // Pro) so the list can reach beyond the first page.
    transactionCount: number;
  };
  portfolios: Array<{
    id: number;
    name: string;
    slug: string;
    type: 'connected' | 'manual';
    chainId: number | null;
    chainName: string | null; // from portfolio.chain.name (null for manual)
    // retrofit-66: ISO inception date = min(createdAt, earliest logged-tx timestamp). The
    // frontend clamps the MANUAL value-history reconstruction to it so a freshly-added manual
    // portfolio's chart doesn't extend back before the portfolio actually existed. Connected
    // portfolios carry it too but the frontend only uses it for the manual reconstruction.
    inceptionDate: string;
    assetCount: number; // # assets with balance > 0
    totalValue: number;
    // retrofit-79 (§2/D1): null when there's no approx=false snapshot baseline for the window
    // (frontend renders "—" = unknown, distinct from a real flat 0).
    pnl24h: number | null;
    pnl24hValue: number | null;
    // retrofit-75 (R39) + retrofit-79 (§1c/§4): canonical per-type all-time — manual → cost-basis
    // (unrealized+realized / unrealizedPnlPct); connected → cost-basis from provider PnL, or null
    // ("—") when the wallet has no provider cost basis (never the old snapshot-delta number).
    pnlAllTime: number | null;
    pnlAllTimeValue: number | null;
    // retrofit-27: average-cost PnL per portfolio (additive).
    unrealizedPnlValue: number;
    unrealizedPnlPct: number;
    realizedPnlValue: number;
    allTimePnlValue: number;
    // retrofit-28: raw per-portfolio position data so the FRONTEND can recompute every
    // displayed figure from the live-price firehose (falling back to the daily DB price
    // when a symbol has no live tick). Excludes balance <= 0. `balance` is full-precision
    // quantity; avgCost/costBasis/realizedPnl are taken straight off the Asset (maintained
    // by recalc — no new computation here). avgCost is null for cost-unknown holdings.
    holdings: Array<{
      symbol: string;
      balance: number;
      avgCost: number | null;
      costBasis: number;
      realizedPnl: number;
    }>;
  }>;
  valueHistory: Array<{ date: string; value: number }>; // 'YYYY-MM-DD', aggregate (all portfolios), asc
  // retrofit-56: the CONNECTED-only slice of the recorded snapshot series (same forward-fill,
  // same `days` window). The frontend reconstructs the MANUAL portion from per-portfolio
  // holdings × transactions and adds this — connected wallets use recorded value history
  // instead of the (wrong-for-windowed-imports) frontend reconstruction. `[]` when the user
  // has no connected portfolios (or none have snapshots yet).
  connectedValueHistory: Array<{ date: string; value: number }>; // 'YYYY-MM-DD', connected-only, asc
  allocation: Array<{ symbol: string; value: number; percentage: number }>; // desc by value
  // retrofit-28: aggregate per-symbol position summed across portfolios. `balance` is the
  // summed raw quantity; `costBasis`/`realizedPnl` are summed across portfolios; `avgCost`
  // is the balance-weighted average of the per-portfolio avgCost over cost-tracked assets
  // (Σ(avgCost×balance)/Σ(balance) over avgCost!=null assets), null when none track cost.
  // Lets the dashboard do aggregate live PnL without re-summing the portfolio rows.
  holdings: Array<{
    symbol: string;
    balance: number;
    avgCost: number | null;
    costBasis: number;
    realizedPnl: number;
  }>;
  recentTransactions: TransactionListDTO[]; // most recent `txLimit`, desc by timestamp
  // retrofit-18: catalog tokens with a live `price:<SYMBOL>` tick, ranked by |24h change|
  // desc and capped at 6 (biggest movers in EITHER direction). Global (same for every
  // user), cached under `overview_top_movers`; `[]` when no symbol has a fresh tick.
  // retrofit-20: each mover carries a sampled recent price series (`spark`, oldest→newest,
  // read from `price_hist:<SYMBOL>`) for the frontend's trend line; `[]` until ≥2 samples
  // accrue (the resolver samples at ≥5-min intervals).
  topMovers: Array<{ symbol: string; name: string; change24h: number; spark: number[] }>;
}
