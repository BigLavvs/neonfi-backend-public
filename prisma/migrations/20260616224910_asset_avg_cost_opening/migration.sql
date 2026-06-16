-- retrofit-27: average-cost PnL + opening balances.
--   The new asset.* columns default to "no opening cost tracked": openingBalance=0,
--   openingCostBasis=NULL, realizedPnl=0, avgCost=NULL, costBasis=0. Existing seeded
--   `buy` transactions REMAIN buys and keep providing cost basis via recalc.ts — no
--   data backfill is required (the column defaults are the intended backfill values).
--   The subscription FK / transaction_direction.name statements below are pre-existing
--   schema-drift reconciliation captured by `prisma migrate dev`; they touch no data.

-- DropForeignKey
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_scheduledBillingCycleId_fkey";

-- DropForeignKey
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_scheduledPlanId_fkey";

-- DropForeignKey
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_directionId_fkey";

-- AlterTable
ALTER TABLE "asset" ADD COLUMN     "avgCost" DECIMAL(20,8),
ADD COLUMN     "costBasis" DECIMAL(20,8) NOT NULL DEFAULT 0,
ADD COLUMN     "openingAt" TIMESTAMP(3),
ADD COLUMN     "openingBalance" DECIMAL(20,8) NOT NULL DEFAULT 0,
ADD COLUMN     "openingCostBasis" DECIMAL(20,8),
ADD COLUMN     "realizedPnl" DECIMAL(20,8) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transaction_direction" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_scheduledPlanId_fkey" FOREIGN KEY ("scheduledPlanId") REFERENCES "plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_scheduledBillingCycleId_fkey" FOREIGN KEY ("scheduledBillingCycleId") REFERENCES "billing_cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_directionId_fkey" FOREIGN KEY ("directionId") REFERENCES "transaction_direction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
