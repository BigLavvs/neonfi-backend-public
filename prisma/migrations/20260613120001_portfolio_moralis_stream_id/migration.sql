-- Stage 12 bundled fix §6.1: Add moralisStreamId to portfolio table.
-- Stores the Moralis Streams stream ID so deletePortfolio can clean up the stream.
-- Nullable — manual portfolios never have a stream; also null until stream is created.

ALTER TABLE "portfolio" ADD COLUMN "moralisStreamId" VARCHAR(255);
