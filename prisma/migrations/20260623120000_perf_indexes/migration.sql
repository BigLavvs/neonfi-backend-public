-- Audit remediation — performance indexes (audit perf #3, #4, #23).
--
-- Purely ADDITIVE: three CREATE INDEX statements, no column/constraint changes, no data
-- migration. Safe to apply online. (On a large table, prefer CREATE INDEX CONCURRENTLY run
-- outside a transaction — Prisma wraps migrations in a transaction, so the plain form below is
-- what `prisma migrate` will run; switch to CONCURRENTLY + manual apply if the tables are large
-- enough that a brief write-lock matters. These tables are currently small.)

-- #3/#4: recalcAssetBalance filters native_transaction_detail / erc20_transaction_detail by
-- `symbol` on every transaction write (amplified K× in bulk wallet-import loops). Un-indexed,
-- each call full-scans the detail table.
CREATE INDEX "native_transaction_detail_symbol_idx" ON "native_transaction_detail"("symbol");
CREATE INDEX "erc20_transaction_detail_symbol_idx" ON "erc20_transaction_detail"("symbol");

-- #23: dashboard/overview reads filter by portfolio and sort by timestamp; the per-portfolio
-- earliest-transaction lookups do the same. Without this composite, Postgres full-sorts the
-- user's whole transaction set on every dashboard load. Leading portfolioId keeps the existing
-- single-column portfolioId lookups covered, so the prior "transaction_portfolioId_idx" stays
-- as-is (kept for minimal, additive change).
CREATE INDEX "transaction_portfolioId_timestamp_idx" ON "transaction"("portfolioId", "timestamp");
