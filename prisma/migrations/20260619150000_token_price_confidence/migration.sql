-- retrofit-71 (C4): per-token price confidence flag.
-- 'verified' = price confirmed against a canonical feed; 'unverified' = auto-listed wallet
-- token whose provider price could not be cross-checked; NULL = CMC catalog row (trusted).
ALTER TABLE "token" ADD COLUMN "priceConfidence" VARCHAR(20);
