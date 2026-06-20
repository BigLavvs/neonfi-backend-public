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
  // retrofit-79 (§1c/§4): null for a CONNECTED wallet with no provider cost basis (the UI shows
  // "—", never the old snapshot-delta number). Manual + connected-with-cost-basis are numbers.
  allTimePnlPct: number | null;
  allTimePnlValue: number | null;
  // retrofit-72 (H9/R37): null for CONNECTED portfolios. The on-chain transfer import is
  // windowed and effectively one-directional, so summing it into deposits/withdrawals produces
  // impossible figures (e.g. $0.41 in vs $516 out). We have no reliable deposit/withdrawal ledger
  // for a connected wallet, so the UI shows "—" rather than a number that implies a complete one.
  totalDeposits: number | null;
  totalWithdrawals: number | null;
  // retrofit-79 (§6): the CONNECTED equivalent of deposits/withdrawals, from the provider PnL.
  // totalInvested = Σ current Asset.costBasis (the floor — excludes since-sold lots); realizedPnl
  // = Σ per-token realized PnL. Both null for MANUAL (which keeps Deposits/Withdrawals) and for a
  // connected wallet with no provider cost basis (§4).
  totalInvested: number | null;
  realizedPnl: number | null;
  // retrofit-79 (§2/D1): null when there's no approx=false snapshot baseline for the window.
  pnl7d: number | null;
  pnl7dValue: number | null;
  pnl30d: number | null;
  pnl30dValue: number | null;
}

export interface PerformanceDTO {
  portfolioId: number;
  // ASC by date; `date` is a bare YYYY-MM-DD calendar day. AreaChart consumes the
  // points left-to-right, so ascending is the natural order.
  // retrofit-81 (reverts retrofit-79 §3): approx (backfilled-estimate) snapshots are no longer
  // omitted — every recorded point is returned, each carrying `approx` so the chart can draw the
  // estimated portion distinctly instead of deleting the timeline. `approx=false` for real daily
  // observations (manual portfolios are all false by default).
  snapshots: Array<{ date: string; value: number; approx: boolean }>;
}

export interface HoldingsDTO {
  portfolioId: number;
  // Sorted by `value` DESC, zero-balance assets filtered out. `value` is USD;
  // `portfolioPercentage` is 0-100, rounded to 2dp (retrofit-4).
  assets: Array<{ symbol: string; value: number; portfolioPercentage: number }>;
}
