-- retrofit-7 (C3a): user-entered priceAtTime drives usdValue for manual entries + transaction notes.
--
-- priceAtTime is the price the user entered when logging a manual buy/sell. For manual
-- transactions it now drives usdValue (usdValue = amount × priceAtTime), giving accurate
-- cost basis. This REVERSES the retrofit-2 "current price at write-time" simplification
-- for manual txns only — webhook/connected transactions are unchanged (still current
-- price, priceAtTime stays NULL).
--
-- All three columns are nullable; usdValue stays NOT NULL (retrofit-2 lock). Existing rows
-- need no backfill: priceAtTime NULL means "no override", which matches the current-price
-- usdValue already stored on those rows.

-- Transaction.notes — free-text user note from the frontend AddTransactionModal.
ALTER TABLE "transaction" ADD COLUMN "notes" VARCHAR(2000);

-- NativeTransactionDetail.priceAtTime
ALTER TABLE "native_transaction_detail" ADD COLUMN "priceAtTime" DECIMAL(20, 8);

-- Erc20TransactionDetail.priceAtTime
ALTER TABLE "erc20_transaction_detail" ADD COLUMN "priceAtTime" DECIMAL(20, 8);
