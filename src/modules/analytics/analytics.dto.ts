// Neonfi backend — Analytics module resource representations (Stage 14 §1.3).
//
// Shapes copied verbatim from the architecture resource reps (Neonfi System
// Architecture.docx, ANALYTICS entity, lines 640-669). The frontend consumes these
// directly: performance.snapshots[].value → AreaChart points, .date → labels;
// holdings.assets[].portfolioPercentage → DonutChart segment value.
//
// Frontend-derived fields are deliberately NOT here (Stage 14 §1.3):
//   - allTimePnlPositive — a CSS-class boolean the performance +page.ts derives from
//     allTimePnlValue >= 0; not an API field.
//   - per-token d1/d7/d30 — no architecture-defined historical source (§1.11 MVP gap).

export interface SummaryDTO {
  portfolioId: number;
  allTimePnlPct: number;
  allTimePnlValue: number;
  totalDeposits: number;
  totalWithdrawals: number;
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
  // `portfolioPercentage` is 0-100 unrounded (frontend rounds for display).
  assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
}
