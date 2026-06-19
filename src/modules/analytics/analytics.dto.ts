// Neonfi backend — Analytics module resource representations (Stage 14 §1.3).
//
// Shapes copied verbatim from the architecture resource reps (Neonfi System
// Architecture.docx, ANALYTICS entity, lines 640-669). The frontend consumes these
// directly: performance.snapshots[].value → AreaChart points, .date → labels;
// holdings.assets[].portfolioPercentage → DonutChart segment value.
//
// All numeric outputs are rounded to 2 decimal places on the wire (retrofit-4); see
// `analytics.service.ts` `round`.
//
// Frontend-derived fields are deliberately NOT here (Stage 14 §1.3):
//   - allTimePnlPositive — a CSS-class boolean the performance +page.ts derives from
//     allTimePnlValue >= 0; not an API field.
//   - per-token d1/d7/d30 — no architecture-defined historical source (§1.11 MVP gap).

export interface SummaryDTO {
  portfolioId: number;
  allTimePnlPct: number;
  allTimePnlValue: number;
  // retrofit-72 (H9/R37): null for CONNECTED portfolios. The on-chain transfer import is
  // windowed and effectively one-directional, so summing it into deposits/withdrawals produces
  // impossible figures (e.g. $0.41 in vs $516 out). We have no reliable deposit/withdrawal ledger
  // for a connected wallet, so the UI shows "—" rather than a number that implies a complete one.
  totalDeposits: number | null;
  totalWithdrawals: number | null;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
}

export interface PerformanceDTO {
  portfolioId: number;
  // ASC by date; `date` is a bare YYYY-MM-DD calendar day. AreaChart consumes the
  // points left-to-right, so ascending is the natural order.
  snapshots: Array<{ date: string; value: number }>;
}

export interface HoldingsDTO {
  portfolioId: number;
  // Sorted by `value` DESC, zero-balance assets filtered out. `value` is USD;
  // `portfolioPercentage` is 0-100, rounded to 2dp (retrofit-4).
  assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
}
