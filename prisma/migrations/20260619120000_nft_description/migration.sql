-- retrofit-51: collect the NFT collectible description (Moralis normalized_metadata.description).
-- The image/name are already captured; this is the one missing display field. Nullable, no
-- default — null when the metadata omits it; backfilled over time by the connect-time holdings
-- import + the periodic connected resync.

-- AlterTable
ALTER TABLE "nft" ADD COLUMN     "description" TEXT;
