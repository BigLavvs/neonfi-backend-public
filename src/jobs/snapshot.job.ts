// Neonfi backend — Daily Balance Snapshot job (PLACEHOLDER).
// Real implementation: Stage 13. Writes one BalanceSnapshot per Pro portfolio
// per day into the TimescaleDB hypertable (idempotent via
// @@unique([portfolioId, snapshotDate])); invalidates the Redis PnL cache.
export {};
