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
    pnl24hValue: number; // Σ portfolio.pnl24hValue
    pnlAllTime: number; // aggregate % (legacy netDeposit-based — KEPT, retrofit-27 Augment)
    pnlAllTimeValue: number; // Σ portfolio.pnlAllTimeValue (legacy netDeposit-based)
    // retrofit-27: average-cost PnL aggregate (additive). allTimePnlValue = unrealized +
    // realized; unrealizedPnlPct is over Σ(costBasis) across all the user's assets.
    unrealizedPnlValue: number;
    unrealizedPnlPct: number;
    realizedPnlValue: number;
    allTimePnlValue: number;
    portfolioCount: number;
    transactionCount: number; // across all the user's portfolios
  };
  portfolios: Array<{
    id: number;
    name: string;
    slug: string;
    type: 'connected' | 'manual';
    chainId: number | null;
    chainName: string | null; // from portfolio.chain.name (null for manual)
    assetCount: number; // # assets with balance > 0
    totalValue: number;
    pnl24h: number;
    pnl24hValue: number;
    pnlAllTime: number;
    pnlAllTimeValue: number;
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
  valueHistory: Array<{ date: string; value: number }>; // 'YYYY-MM-DD', aggregate, asc
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
  // retrofit-45: per-transaction chart markers — one entry per buy/sell in the range,
  // newest-first, capped at 500. Transfer-group legs are excluded (they net to zero
  // across portfolios and would confuse the chart). `valueAfter` is the reconstructed
  // portfolio total right AFTER the transaction at that day's price.
  markers: Array<{
    timestamp: string;  // ISO 8601
    direction: string;  // 'buy' | 'sell'
    symbol: string;
    usdValue: number;
    valueAfter: number;
  }>;
  // retrofit-18: catalog tokens with a live `price:<SYMBOL>` tick, ranked by |24h change|
  // desc and capped at 6 (biggest movers in EITHER direction). Global (same for every
  // user), cached under `overview_top_movers`; `[]` when no symbol has a fresh tick.
  // retrofit-20: each mover carries a sampled recent price series (`spark`, oldest→newest,
  // read from `price_hist:<SYMBOL>`) for the frontend's trend line; `[]` until ≥2 samples
  // accrue (the resolver samples at ≥5-min intervals).
  topMovers: Array<{ symbol: string; name: string; change24h: number; spark: number[] }>;
}
