-- retrofit-21: daily per-token price history.
--
-- TokenPriceSnapshot stores one USD price per catalog token per UTC day, sampled by
-- snapshot.job.ts. Modelled on balance_snapshot: `id` is a plain SERIAL (NOT the PK),
-- and the composite PRIMARY KEY (tokenId, snapshotDate) makes the daily upsert
-- idempotent (same-day re-run rewrites the price, never a second row). Plain table,
-- not a TimescaleDB hypertable — daily granularity keeps it small for MVP.

-- CreateTable
CREATE TABLE "token_price_snapshot" (
    "id" SERIAL NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_price_snapshot_pkey" PRIMARY KEY ("tokenId", "snapshotDate")
);

-- CreateIndex
CREATE INDEX "token_price_snapshot_tokenId_idx" ON "token_price_snapshot"("tokenId");

-- AddForeignKey
ALTER TABLE "token_price_snapshot" ADD CONSTRAINT "token_price_snapshot_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
