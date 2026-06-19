-- retrofit-55: widen Nft.logoUrl from VarChar(2048) to TEXT so on-chain
-- data: URI images (e.g. Uniswap V3 LP position generative SVGs) don't overflow.
ALTER TABLE "nft" ALTER COLUMN "logoUrl" TYPE TEXT;
