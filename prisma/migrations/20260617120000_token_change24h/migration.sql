-- retrofit-39: persist the CMC 24h % change on the token catalog as a cold-cache
-- fallback for the wallet badge (so a covered token with no fresh live `price:<SYM>`
-- tick still shows a slightly-stale 24h change instead of a bare "—"). Nullable,
-- no default — unknown until the next 6-hourly sync / catalog ingest writes it.

-- AlterTable
ALTER TABLE "token" ADD COLUMN "change24h" DECIMAL(10,4);
