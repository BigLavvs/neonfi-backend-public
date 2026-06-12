-- Add transaction_direction lookup table
CREATE TABLE "transaction_direction" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR NOT NULL UNIQUE
);

-- Seed the three values
INSERT INTO "transaction_direction" ("name") VALUES ('buy'), ('sell'), ('transfer');

-- Add directionId to transaction (nullable temporarily for safe rollout)
ALTER TABLE "transaction" ADD COLUMN "directionId" INTEGER REFERENCES "transaction_direction"(id);

-- For any existing rows (none expected — Stage 9A is the first transaction stage), default to 'buy'
UPDATE "transaction" SET "directionId" = (SELECT id FROM "transaction_direction" WHERE name = 'buy') WHERE "directionId" IS NULL;

-- Make NOT NULL
ALTER TABLE "transaction" ALTER COLUMN "directionId" SET NOT NULL;

-- Index for joins
CREATE INDEX "transaction_directionId_idx" ON "transaction"("directionId");
