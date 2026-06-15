-- retrofit-10 (C4b): cross-portfolio transfer.
--
-- Transaction.transferGroupId links the two legs of a transfer (a `sell` in the source
-- portfolio + a `buy` in the dest, sharing this UUID) so the frontend can group/label
-- the pair and the backend can delete both legs together. Nullable; existing rows are
-- unaffected (NULL = not a transfer). Indexed for the delete-pair lookup
-- (findMany({where:{transferGroupId}})).

ALTER TABLE "transaction" ADD COLUMN "transferGroupId" VARCHAR(36);

CREATE INDEX "transaction_transferGroupId_idx" ON "transaction"("transferGroupId");
