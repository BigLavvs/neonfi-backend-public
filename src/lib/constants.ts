/**
 * TimescaleDB snapshot retention window (Stage 13).
 * Drop balance_snapshot chunks older than this. Locked by Idowu at Appendix item 8.
 * Pro portfolios only — free portfolios never produce snapshots, so retention is moot for them.
 */
export const SNAPSHOT_RETENTION_DAYS = 730; // 24 months
