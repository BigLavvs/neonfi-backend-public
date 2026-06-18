-- retrofit-48: connected-wallet token accuracy.
--
-- Two nullable/defaulted columns on the token catalog (symbol stays the UNIQUE key):
--   contractAddress — on-chain identity for precise connected-wallet resolution +
--     per-contract re-pricing. Nullable (existing CMC rows have no contract). NOT unique
--     (the same string can recur across chains); indexed for lookups only. Stored
--     lower-cased for EVM, Solana mints as-is.
--   autoListed — true when the row was auto-created from a connected wallet's holdings
--     (not the CMC catalog). The connected-reprice job refreshes ONLY these tokens' price;
--     CMC/catalog tokens stay false and are priced by token-sync + the firehose.

-- AlterTable
ALTER TABLE "token" ADD COLUMN "contractAddress" VARCHAR(255);
ALTER TABLE "token" ADD COLUMN "autoListed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "token_contractAddress_idx" ON "token"("contractAddress");
