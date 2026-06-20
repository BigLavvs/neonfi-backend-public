-- retrofit-84 (H13): combined NFT spam verdict. true = provider flag (Moralis possible_spam /
-- Alchemy spam-contract DB / GoldRush is_spam) OR a conservative name/collection heuristic hit.
-- The holdings list + NFT count filter on this column (possibleSpam stays the raw provider signal),
-- so airdrop/scam NFTs ("Garbage Bags", "Hefty Presents") are hidden by default but never deleted
-- (a "Show spam" toggle can still surface them). Existing rows default false and are re-evaluated by
-- the reclassify backfill / next resync.
ALTER TABLE "nft" ADD COLUMN "spam" BOOLEAN NOT NULL DEFAULT false;
