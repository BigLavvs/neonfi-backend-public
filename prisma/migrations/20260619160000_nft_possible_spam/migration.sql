-- retrofit-73 (H13): persist Moralis' possible_spam flag on NFT holdings so airdrop/scam
-- NFTs can be filtered out of the holdings list (or badged) instead of shown as real holdings.
ALTER TABLE "nft" ADD COLUMN "possibleSpam" BOOLEAN NOT NULL DEFAULT false;
