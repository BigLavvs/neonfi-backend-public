-- retrofit-74 (§4): make the transaction hash unique PER PORTFOLIO instead of globally.
--
-- The old global unique on transaction.transactionHash meant a wallet connected in two
-- portfolios (or re-added) imported 0 transfers after the first portfolio claimed each hash.
-- Dropping it for a composite (portfolioId, transactionHash) unique lets each portfolio import
-- its own copy of a transfer while still deduping a re-imported hash WITHIN a portfolio (the
-- P2002 → TRANSACTION_HASH_DUPLICATE path). Null hashes (manual transactions) stay distinct
-- under a Postgres unique index, so multiple hash-less rows per portfolio remain allowed.

-- DropIndex
DROP INDEX "transaction_transactionHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "transaction_portfolioId_transactionHash_key" ON "transaction"("portfolioId", "transactionHash");
