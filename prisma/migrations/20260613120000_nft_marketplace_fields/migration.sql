-- Stage 12: Add 7 marketplace fields to nft table.
-- Architecture rep specifies these fields; Neonfi Database Schema.docx omits them.
-- Same defect pattern as Session.refreshTokenHash, Transaction.directionId, etc.
-- All columns nullable — Moralis returns them when available; DTO returns null otherwise.

ALTER TABLE "nft" ADD COLUMN "tokenStandard"  VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "floorPrice"     VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "floorPriceUsd"  VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "lastSale"       VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "lastSaleNote"   VARCHAR(100);
ALTER TABLE "nft" ADD COLUMN "rarity"         VARCHAR(100);
ALTER TABLE "nft" ADD COLUMN "traits"         JSONB;
