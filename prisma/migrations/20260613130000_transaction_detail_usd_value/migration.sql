-- retrofit-2: add usdValue to the two balance-affecting transaction detail tables.
--
-- Implements Option (a) for USD-at-transaction-time. usdValue = amount × price.
-- NftTransactionDetail is intentionally excluded — NFTs are ownership state, not
-- balance-affecting, and contribute no PnL.
--
-- BACKFILL SEMANTICS (LOCKED — acceptable MVP simplification, retrofit-2 §1.2):
-- existing rows are backfilled from the CURRENT Token.currentPrice, NOT the price
-- at the historical transaction timestamp. We never stored historical prices, and
-- the dev DB has only a handful of test rows (production hasn't shipped). A
-- post-MVP retrofit could backfill accurately from CMC historical data if needed.

-- NativeTransactionDetail ---------------------------------------------------
ALTER TABLE "native_transaction_detail" ADD COLUMN "usdValue" DECIMAL(20, 8);
-- Backfill from current Token.currentPrice × amount
UPDATE "native_transaction_detail" nd
SET "usdValue" = nd."amount" * t."currentPrice"
FROM "token" t
WHERE t."symbol" = nd."symbol";
-- Any rows where the token isn't in the catalog (shouldn't exist in practice but
-- guard against null-fail on the NOT NULL lock below): backfill to 0.
UPDATE "native_transaction_detail" SET "usdValue" = 0 WHERE "usdValue" IS NULL;
-- Lock NOT NULL
ALTER TABLE "native_transaction_detail" ALTER COLUMN "usdValue" SET NOT NULL;

-- Erc20TransactionDetail — same shape ---------------------------------------
ALTER TABLE "erc20_transaction_detail" ADD COLUMN "usdValue" DECIMAL(20, 8);
UPDATE "erc20_transaction_detail" ed
SET "usdValue" = ed."amount" * t."currentPrice"
FROM "token" t
WHERE t."symbol" = ed."symbol";
UPDATE "erc20_transaction_detail" SET "usdValue" = 0 WHERE "usdValue" IS NULL;
ALTER TABLE "erc20_transaction_detail" ALTER COLUMN "usdValue" SET NOT NULL;
