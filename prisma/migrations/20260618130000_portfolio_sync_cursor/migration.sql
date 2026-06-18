-- retrofit-49: connected-wallet transfer-history import.
--
-- Two nullable columns on portfolio for the paginated "load more" history import:
--   syncCursor      — provider pagination cursor for the next page of transfers (text,
--                     null = no more / done / manual portfolio). Moralis cursors are long
--                     opaque tokens, hence text rather than a bounded VARCHAR.
--   externalTxCount — provider-reported total tx count for the wallet (#8); null when the
--                     provider gives no cheap total, in which case the overview transaction
--                     count falls back to the imported DB row count for that portfolio.

-- AlterTable
ALTER TABLE "portfolio" ADD COLUMN "syncCursor" TEXT;
ALTER TABLE "portfolio" ADD COLUMN "externalTxCount" INTEGER;
