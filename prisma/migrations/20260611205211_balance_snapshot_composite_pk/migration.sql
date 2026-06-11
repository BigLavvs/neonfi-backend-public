/*
  Warnings:

  - The primary key for the `balance_snapshot` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropIndex
DROP INDEX "balance_snapshot_portfolioId_snapshotDate_key";

-- AlterTable
ALTER TABLE "balance_snapshot" DROP CONSTRAINT "balance_snapshot_pkey",
ADD CONSTRAINT "balance_snapshot_pkey" PRIMARY KEY ("portfolioId", "snapshotDate");
