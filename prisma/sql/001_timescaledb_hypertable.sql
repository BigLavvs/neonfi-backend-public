-- Neonfi backend — TimescaleDB hypertable conversion for `balance_snapshot`.
--
-- WHEN: run AFTER `prisma migrate deploy` (the table is created by Prisma as a
--   regular table first). The CD deploy step runs this if not already applied
--   (System_Implementation Deployment Flow; Build Guide §1.3 / §6.5).
--
-- CONNECTION: MUST run on the Neon DIRECT_URL (the direct, non-pooled host) — not
--   the pooled DATABASE_URL. Extension creation and hypertable conversion require
--   the direct connection per Neon + Prisma requirements. The runner
--   (prisma/sql/run-hypertable.ts) enforces this by connecting via DIRECT_URL.
--
-- IDEMPOTENT: both statements are safe to re-run.
--
-- DELIBERATELY OMITTED (Neon's Apache-2 TimescaleDB does not support them, and
-- the Build Guide §1.3 / §6.5 drop them):
--   * NO compression: no `ALTER TABLE ... SET (timescaledb.compress ...)`,
--     no `add_compression_policy`, no `compress_after`.
--   * NO continuous aggregates.
--   * NO retention here: `drop_chunks` retention is a Stage 13 scheduled job with
--     a design-time window (Appendix item 8) — NOT added in Part 1.

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('balance_snapshot', 'snapshot_date', if_not_exists => TRUE);
