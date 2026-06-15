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
    pnlAllTime: number; // aggregate %
    pnlAllTimeValue: number; // Σ portfolio.pnlAllTimeValue
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
  }>;
  valueHistory: Array<{ date: string; value: number }>; // 'YYYY-MM-DD', aggregate, asc
  allocation: Array<{ symbol: string; value: number; percentage: number }>; // desc by value
  holdings: Array<{ symbol: string; balance: number }>; // aggregate balance per symbol
  recentTransactions: TransactionListDTO[]; // most recent `txLimit`, desc by timestamp
}
