// Neonfi backend — shared portfolio derived-cache key list (Stage 14 §1.9).
//
// Single source for every derived-cache key associated with a portfolio. Used by
// transactions.service.invalidatePnlCache (retrofit-2 CUD hook) and the snapshot
// job's per-upsert hook (retrofit-3), plus tests/helpers.ts truncate. Stage 14 adds
// the three analytics keys; future derived caches add their keys here too so every
// invalidation callsite stays in sync from one place.
export function portfolioDerivedCacheKeys(portfolioId: number): string[] {
  return [
    `portfolio_pnl:${portfolioId}`,
    `analytics_summary:${portfolioId}`,
    `analytics_performance:${portfolioId}`,
    `analytics_holdings:${portfolioId}`,
  ];
}
