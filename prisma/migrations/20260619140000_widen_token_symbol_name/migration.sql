-- retrofit-58 Part 4: widen Token + transaction-detail symbol/name columns.
--
-- Connected-wallet sync auto-lists arbitrary on-chain tokens, and scam/airdrop tokens stuff
-- long URLs into their name/symbol. The old VarChar(20)/VarChar(255) bounds threw "value too
-- long for column" on token.create, so the token was silently skipped (retrofit-57). Widen the
-- free-text names to TEXT and the symbols to a generous VarChar(255) (still bounded — symbol is
-- the unique catalog key + a Redis key).
ALTER TABLE "token" ALTER COLUMN "symbol" TYPE VARCHAR(255);
ALTER TABLE "token" ALTER COLUMN "name" TYPE TEXT;
ALTER TABLE "native_transaction_detail" ALTER COLUMN "symbol" TYPE VARCHAR(255);
ALTER TABLE "erc20_transaction_detail" ALTER COLUMN "symbol" TYPE VARCHAR(255);
ALTER TABLE "erc20_transaction_detail" ALTER COLUMN "tokenSymbol" TYPE VARCHAR(255);
ALTER TABLE "erc20_transaction_detail" ALTER COLUMN "tokenName" TYPE TEXT;
