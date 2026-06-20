-- retrofit-86 (H13.1): per-NFT MANUAL spam override — the honest two-way escape hatch for the
-- behavioral spam signal's residual false-positive risk. NULL = no override (use the computed
-- `spam`), true = force spam (hidden), false = force visible. Applied at READ time
-- (effectiveNftSpam = spamOverride ?? spam) so a resync recomputing `spam` never clobbers a user's
-- decision. Nullable, no default — existing rows have no override.
ALTER TABLE "nft" ADD COLUMN "spamOverride" BOOLEAN;
