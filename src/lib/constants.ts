/**
 * TimescaleDB snapshot retention window (Stage 13).
 * Drop balance_snapshot chunks older than this. Locked by Idowu at Appendix item 8.
 * Pro portfolios only — free portfolios never produce snapshots, so retention is moot for them.
 */
export const SNAPSHOT_RETENTION_DAYS = 730; // 24 months

/**
 * Refund eligibility window (audit decision 2). A succeeded payment is refundable for this long
 * after creation. SINGLE SOURCE OF TRUTH: used by the refund service (eligibility gate) and the
 * payments DTO (the `refundAvailable` flag the frontend renders from), so the two never disagree.
 */
export const REFUND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
