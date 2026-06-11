-- Stage 1A: add refresh token hash column to session table.
-- Applied manually (prisma migrate deploy) — Neon does not support Prisma's
-- shadow-database comparison so prisma migrate dev is not used after initial setup.

-- AlterTable: add column with temporary default to satisfy NOT NULL,
-- then drop the default so the column has no server-side default.
ALTER TABLE "session" ADD COLUMN "refreshTokenHash" VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE "session" ALTER COLUMN "refreshTokenHash" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "session_refreshTokenHash_key" ON "session"("refreshTokenHash");
