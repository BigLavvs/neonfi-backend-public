# Neonfi backend — Stage 9A: Transactions CRUD + balance recalculation

This file is the source-of-truth intent for Stage 9A. Build from this; report back to Idowu when done. Stage 9B (token metadata sync job) is a separate prompt.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 8 landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-8.md` (this repo). Stage 9A reuses every prior pattern including Stage 8's nested-router pattern (portfolio-ownership middleware), the schema delta pattern from Stage 1A (refreshTokenHash) and Stage 3B (scheduledPlanId), the Neon `{ timeout: 15000 }` + lookups-outside-transaction pattern from Stage 4A, the FK-safe test cleanup order, and Stage 8's derive.ts extension pattern (which Stage 9A will extend further).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 9 in §3 in full**, especially the polymorphic-write pseudocode and the Divergence Watch ("type and direction are different axes — conflating them is divergence"), **§2.4 Pagination + Filtering + Sorting**, **§2.6 Idempotency** (Stripe webhook + Moralis webhook idempotency rules — Stage 9A's hash-uniqueness check is a softer version of the same idea).
3. `Neonfi System Architecture.docx` — **TRANSACTION** entity (URLs, resource rep with both `type` and `direction`, the per-type detail child objects), **Transaction Module** rules.
4. `prisma/schema.prisma` — `Transaction`, `TransactionType`, `NativeTransactionDetail`, `Erc20TransactionDetail`, `NftTransactionDetail`. Important: **`Transaction` does NOT currently have a `direction` column.** Stage 9A fixes this via schema delta per §1.2.
5. The frontend code that consumes these endpoints:
   - `src/lib/components/modals/AddTransactionModal.svelte:201` — calls `POST /portfolios/{portfolioId}/transactions`.
   - `src/routes/(dashboard)/wallet/[portfolioSlug]/+page.ts` — calls `GET /portfolios/{portfolioId}/transactions`.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Polymorphic dispatch — `type` selects the child detail table [LOCKED]

`POST /portfolios/{portfolioId}/transactions` body shape depends on `type`:

```ts
// type='native'
{ type: 'native', direction, amount, symbol, timestamp, transactionHash?, from?, to?, gasFee? }

// type='erc20'
{ type: 'erc20', direction, amount, symbol, tokenContractAddress, tokenName, tokenSymbol, timestamp, transactionHash?, from?, to?, gasFee? }

// type='nft'
{ type: 'nft', direction, tokenContractAddress, nftTokenId, nftName?, collectionName?, timestamp, transactionHash?, from?, to?, gasFee? }
```

`type` lives on the base `Transaction` table (FK to `TransactionType` per existing §0.4 lookup-table pattern). After the base row is inserted, the corresponding child detail row gets inserted:

- `type='native'` → `NativeTransactionDetail` (amount, symbol)
- `type='erc20'` → `Erc20TransactionDetail` (amount, symbol, tokenContractAddress, tokenName, tokenSymbol)
- `type='nft'` → `NftTransactionDetail` (tokenContractAddress, nftName?, nftTokenId, collectionName?)

Both writes happen in one Prisma `$transaction` per §1.7 below. Discriminated union via Zod handles the per-type shape validation. Use `.strict()` so cross-shape fields (e.g. `type='nft'` with `amount` field) are rejected.

### 1.2 Schema delta — add `Transaction.direction` lookup table + FK [LOCKED]

The architecture rep treats `direction` as a first-class Transaction field ("buy | sell | transfer") AND the balance recalculation rule reads from it. But the schema docx has no `direction` column on Transaction. This is a docx defect of the same family as `Payment.user` (Stage 1A), `BalanceSnapshot` PK (Stage 1A), `Session.refreshTokenHash` (Stage 1A), and `Subscription.scheduledPlanId` (Stage 3B).

Apply the schema delta with the same pattern. New lookup table + FK column on Transaction:

**Migration SQL** (`prisma/migrations/<timestamp>_transaction_direction/migration.sql`):
```sql
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
```

Apply via the established Neon-shadow-DB pattern:
```bash
npx prisma db execute --file prisma/migrations/<ts>_transaction_direction/migration.sql --url $env:DIRECT_URL
npx prisma migrate resolve --applied <ts>_transaction_direction
npx prisma generate
```

**Prisma schema additions**:
```prisma
model TransactionDirection {
  id           Int           @id @default(autoincrement())
  name         String        @unique
  transactions Transaction[] @relation("TransactionDirection")
  @@map("transaction_direction")
}

model Transaction {
  // existing fields unchanged
  direction    TransactionDirection @relation("TransactionDirection", fields: [directionId], references: [id])
  directionId  Int
  @@index([directionId])
}
```

**Seed update**: extend `prisma/seed.ts` to upsert the three transaction_direction rows alongside the other lookup tables. Idempotent.

This delta adds two items to the doc-fix pile:
- `Neonfi Database Schema.docx` Transaction: add `direction` lookup-table FK (mirrors the existing `type` pattern).
- `Neonfi Database Schema.docx` add new model `TransactionDirection` with `name` values `buy`, `sell`, `transfer`.

### 1.3 Balance recalc rule — buy adds, sell subtracts, transfer is a no-op [LOCKED, simplified for MVP]

For manual portfolios, Asset.balance is derived from the full transaction history for that (portfolio, token) pair. The recalc function iterates all transactions matching the asset and applies:

```
For each transaction in (portfolio, asset's token), oldest to newest:
  - direction='buy'   → balance += amount
  - direction='sell'  → balance -= amount
  - direction='transfer' → balance unchanged
```

`amount` lives on `NativeTransactionDetail.amount` or `Erc20TransactionDetail.amount`. For `nft` type, balance isn't a quantity — NFTs are tracked as ownership state in the `Nft` table (Stage 12), not by balance. **NFT transactions do NOT trigger asset-balance recalc.**

The transfer-is-no-op simplification matches the common "transfer between own wallets = net zero" interpretation. Users who genuinely send tokens out should use 'sell' (or 'transfer' if they want to log the movement without affecting balance — their call). Document this in code comments AND in the commit-report doc-fix pile so the architecture docx can clarify the semantics. If product wants richer transfer semantics later (transfer_in/transfer_out), that's a §0.1-clean schema change with a doc update — not Stage 9A's scope.

The recalc reads `Erc20TransactionDetail.symbol` (or `NativeTransactionDetail.symbol`) to identify which token the transaction concerns. Map symbol → tokenId via `prisma.token.findUnique({ where: { symbol } })`. If the symbol doesn't match a known token: warning log, skip the transaction (don't fail recalc; the user can fix the data later). This handles the edge case of historical transactions for tokens not in our catalog.

Token lookup is symbol-based here because that's what the detail tables store. The Build Guide §Stage 9 hints at this: "asset balance recalculated from transaction history per direction."

After recalc, update the Asset row: `prisma.asset.update({ where: { portfolioId_tokenId: { portfolioId, tokenId } }, data: { balance: newBalance } })`. If no matching Asset row exists (user logged a transaction for a token not yet added as an asset), one of two paths:
- (a) Auto-create the Asset row with the computed balance.
- (b) Reject the transaction at create-time with `400 ASSET_NOT_IN_PORTFOLIO`.

**Pick (b).** Forces users to add the token to the portfolio first (Stage 8 POST /assets), then log transactions. Stage 8's plan-rank check then naturally gates which tokens can have transactions (free users can't sneak rank-15 tokens in via transaction logging).

### 1.4 Connected portfolios are read-only [LOCKED, same as Stage 8]

`POST`, `PATCH`, `DELETE` on transactions in a connected portfolio → `403 CONNECTED_PORTFOLIO_READ_ONLY`. The portfolio-ownership middleware loads the portfolio; controllers check `portfolio.type.name === 'connected'` before mutation.

`GET` (list + detail) works on both connected and manual portfolios.

Stage 11 (Moralis webhook) will be the only writer into connected-portfolio transactions, bypassing the controller entirely.

### 1.5 Idempotency via `transactionHash` uniqueness [LOCKED]

Schema has `Transaction.transactionHash @unique` (nullable for manual entries without a hash). On `POST`:

- If `transactionHash` is null/empty in body: insert with NULL, no idempotency check. Manual portfolios often log transactions without hashes (cash purchases, exchange trades).
- If `transactionHash` is present: check uniqueness via the constraint. If duplicate insert → `409 TRANSACTION_HASH_DUPLICATE`.

The Build Guide §2.6 Idempotency Rules only mandate idempotency for Stripe webhook, Moralis webhook, and Snapshot job. User-driven transaction logging isn't on that list, but the schema constraint gives us idempotency for free when hashes are provided — surface the right error code rather than the raw Prisma constraint violation.

### 1.6 PATCH allows updating mutable fields; recalc runs after [LOCKED]

`PATCH /portfolios/{portfolioId}/transactions/{id}` body (Zod, `.strict()`, all fields optional):

```ts
{
  direction?: 'buy' | 'sell' | 'transfer',
  amount?: string,    // decimal string, type='native' or 'erc20' only
  symbol?: string,    // type='native' or 'erc20' only
  from?: string | null,
  to?: string | null,
  gasFee?: string | null,
  timestamp?: string, // ISO 8601
  // tokenContractAddress, tokenName, tokenSymbol, nftName, nftTokenId, collectionName — type-specific, mutable
}
```

`type` is IMMUTABLE — once a Transaction is `native`, it can't become `erc20`. Changing type would require deleting the row and creating a new one with the right child detail. Reject any `type` in PATCH body.

`transactionHash` is also immutable (it's the blockchain truth — changing it is wrong). Reject if present.

After PATCH: re-run `recalcAssetBalance(portfolioId, tokenId)` if any of (amount, direction, symbol) changed. Symbol change is rare but possible if the user fixes a typo.

Empty PATCH body → 200 no-op, return current transaction DTO.

Connected portfolio → 403.

### 1.7 Transaction operations run inside `$transaction` with `{ timeout: 15000 }` [LOCKED, per Stage 4A pattern]

The create/update/delete flows touch multiple tables:
- create: insert Transaction + insert child detail + run recalc + update Asset.balance + invalidate Redis PnL cache (write later — Redis cache wiring is empty until Stage 13).
- update: update Transaction + (maybe) update child detail + recalc + update Asset.balance + cache invalidate.
- delete: delete Transaction (cascade deletes child detail) + recalc + update Asset.balance + cache invalidate.

Wrap each in `prisma.$transaction(async (tx) => { ... }, { timeout: 15000 })`. Lookups for static seed data (TransactionType, TransactionDirection) happen OUTSIDE the transaction — same pattern as Stage 4A's webhook handlers. Pass `tx` through to repository helpers.

### 1.8 Listing — offset pagination + type filter + sort [LOCKED by Build Guide §2.4]

`GET /portfolios/{portfolioId}/transactions` query:
- `limit` (1–100, default 20)
- `offset` (≥0, default 0)
- `type` (optional: 'native' | 'erc20' | 'nft')
- `sort` (optional: 'timestamp' | 'createdAt', default 'timestamp')
- `order` (optional: 'asc' | 'desc', default 'desc' — newest first)

Response: `200 { data: { transactions: [...] }, meta: { limit, offset, total } }`. The list response does NOT include the child detail object — only base Transaction fields + the resolved `type` and `direction` strings. Use `GET /portfolios/{portfolioId}/transactions/{id}` to load full detail with the child join.

This is intentional: list responses are small and uniform; detail responses are heavier and per-type. Frontend wallet page reads the list and calls detail on demand for the popup.

## 2. Module scope

```
src/modules/transactions/transactions.controller.ts     # NEW — nested router under /portfolios/:portfolioId/transactions
src/modules/transactions/transactions.service.ts        # NEW — orchestration including recalc
src/modules/transactions/transactions.repository.ts     # NEW — Prisma queries (base + per-type detail writes)
src/modules/transactions/transactions.schemas.ts        # NEW — discriminated union for POST + PATCH schemas
src/modules/transactions/transactions.dto.ts            # NEW — toTransactionListDTO + toTransactionDetailDTO
src/modules/transactions/recalc.ts                      # NEW — recalcAssetBalance helper
src/modules/portfolios/derive.ts                        # NO EDIT — Stage 8 already extended; Stage 9A's recalc writes to Asset.balance which derive.ts reads
prisma/schema.prisma                                    # EDIT — add TransactionDirection model + direction relation
prisma/migrations/<ts>_transaction_direction/migration.sql  # NEW — hand-written, applied via prisma db execute
prisma/seed.ts                                          # EDIT — seed transaction_direction rows
src/app.ts                                              # EDIT — mount nested transactions router
tests/transactions.test.ts                              # NEW — ~25 tests
tests/portfolios.test.ts, tests/assets.test.ts          # EDIT cleanup beforeEach: add transaction.deleteMany() before asset.deleteMany() (FK-safe order)
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `POST /portfolios/{portfolioId}/transactions` — log a transaction (manual only)

**`requireAuth` + portfolio-ownership middleware required.** Body per §1.1 (Zod discriminated union, `.strict()`).

**Flow:**
1. Validate body. Bad shape → `400 VALIDATION_ERROR`.
2. Read portfolio from context. If connected → `403 CONNECTED_PORTFOLIO_READ_ONLY`.
3. Resolve type + direction lookup rows OUTSIDE the transaction (static seeds, cacheable).
4. For native/erc20: resolve `symbol` → tokenId. If symbol unknown → `400 UNKNOWN_TOKEN_SYMBOL`. Check that the Asset row `(portfolioId, tokenId)` exists per §1.3 — if not: `400 ASSET_NOT_IN_PORTFOLIO`.
5. For nft: no tokenId resolution needed (NFTs are tracked by contract+tokenId, not the Token catalog).
6. `prisma.$transaction(async (tx) => { ... }, { timeout: 15000 })`:
   - Insert base Transaction row with `typeId`, `directionId`, `portfolioId`, `from`, `to`, `gasFee`, `transactionHash`, `timestamp`.
   - On Prisma `P2002` for `transactionHash`: throw `TransactionHashDuplicateError`; caught by controller → `409 TRANSACTION_HASH_DUPLICATE`.
   - Insert child detail per type (NativeTransactionDetail / Erc20TransactionDetail / NftTransactionDetail).
   - Recalc Asset.balance per §1.3 (skip for nft). The recalc reads ALL transactions for that asset, so the just-inserted one is included.
7. Map through `toTransactionDetailDTO()` (returns the full shape with joined child).
8. Respond: `201 { data: { transaction: <TransactionDetailDTO> } }`.

### 3.2 `GET /portfolios/{portfolioId}/transactions` — list (manual or connected)

**`requireAuth` + portfolio-ownership middleware required.** Query per §1.8.

**Flow:**
1. Validate query.
2. Build the `where` clause: `{ portfolioId, ...(typeFilter ? { type: { name: typeFilter } } : {}) }`.
3. Two parallel queries:
   - `prisma.transaction.findMany({ where, orderBy: { [sort]: order }, take: limit, skip: offset, include: { type: true, direction: true } })`
   - `prisma.transaction.count({ where })`
4. Map each through `toTransactionListDTO()`. **No child detail in list response.**
5. Respond: `200 { data: { transactions: [...] }, meta: { limit, offset, total } }`.

### 3.3 `GET /portfolios/{portfolioId}/transactions/{id}` — detail with joined child

**`requireAuth` + portfolio-ownership middleware required.**

**Flow:**
1. Load transaction: `prisma.transaction.findUnique({ where: { id }, include: { type: true, direction: true, nativeDetail: true, erc20Detail: true, nftDetail: true } })`.
2. If not found OR `transaction.portfolioId !== portfolio.id`: `404 TRANSACTION_NOT_FOUND` (intra-user, no enumeration concern).
3. Map through `toTransactionDetailDTO()` — picks the right child based on `type.name`. Two of the three child-detail fields will be null (the type-irrelevant ones); the DTO surfaces only the one that matches `type`.
4. Respond: `200 { data: { transaction: <TransactionDetailDTO> } }`.

### 3.4 `PATCH /portfolios/{portfolioId}/transactions/{id}` — update (manual only)

**`requireAuth` + portfolio-ownership middleware required.** Body per §1.6.

**Flow:**
1. Validate body.
2. Portfolio check; connected → 403.
3. Load existing transaction with detail. Not found / wrong portfolio → 404.
4. `prisma.$transaction(async (tx) => { ... }, { timeout: 15000 })`:
   - Update base Transaction with the allowed mutable fields (direction, from, to, gasFee, timestamp).
   - Update child detail (amount, symbol, contract fields) if relevant fields changed.
   - If any balance-affecting field changed (direction, amount, symbol): recalc Asset.balance. Symbol change might mean the OLD asset needs recalc too (old symbol's balance loses this transaction; new symbol's balance gains it). Handle that case: recalc for both old and new tokenId.
5. Map and respond `200 { data: { transaction: <TransactionDetailDTO> } }`.

### 3.5 `DELETE /portfolios/{portfolioId}/transactions/{id}` — remove (manual only)

**`requireAuth` + portfolio-ownership middleware required.**

**Flow:**
1. Portfolio check; connected → 403.
2. Load transaction. Not found / wrong portfolio → 404.
3. Capture the (portfolioId, symbol → tokenId) for post-delete recalc.
4. `prisma.$transaction(async (tx) => { ... }, { timeout: 15000 })`:
   - Delete transaction (cascade deletes the child detail per schema).
   - Recalc Asset.balance for the affected (portfolioId, tokenId).
5. Respond: `200 { data: { ok: true } }`.

## 4. Cross-cutting wiring

### 4.1 Schema migration

Apply per §1.2 using the Neon-shadow-DB pattern. Don't rely on `prisma migrate dev` — that needs the shadow DB Neon doesn't support. The hand-written migration + `prisma db execute` + `prisma migrate resolve --applied` is the right path.

After the migration:
- `prisma generate` updates the client.
- `npm run seed` (or `prisma db seed`) upserts the three transaction_direction rows.

### 4.2 Seed update

Add to `prisma/seed.ts` alongside the other lookup tables:
```ts
await upsertByName(prisma.transactionDirection, ['buy', 'sell', 'transfer']);
```
Update the final `console.log` to include `transaction_direction`.

### 4.3 Mount the nested transactions router

In `src/app.ts`:
```ts
import { transactionsRouter } from './modules/transactions/transactions.controller.js';
api.route('/portfolios/:portfolioId/transactions', transactionsRouter);
```

Sub-router root: `router.post('', ...)`, `router.get('', ...)` per the empty-string convention.

### 4.4 Test cleanup order

The FK chain now goes: `transaction → asset → portfolio`. Update `tests/portfolios.test.ts` and `tests/assets.test.ts` `beforeEach`:

```ts
await prisma.transaction.deleteMany();  // ← NEW
await prisma.asset.deleteMany();
await prisma.portfolio.deleteMany();
// ...
```

Transaction deletion cascades to NativeTransactionDetail / Erc20TransactionDetail / NftTransactionDetail per the schema. No need to delete child detail rows explicitly.

`tests/transactions.test.ts` (new file) uses the same order with `transaction.deleteMany()` near the top.

## 5. Tests (Vitest, integration — new file `tests/transactions.test.ts`)

Test numbering continues from Stage 8's final count (197 if Stage 8 landed there; check the actual).

### POST — 9 tests

198. **POST native buy happy path** → 201; Transaction row created with native detail; Asset.balance updated (e.g., BTC balance from 0 to 0.5).
199. **POST erc20 buy** → 201; Erc20TransactionDetail row created with contract+symbol+amount.
200. **POST nft happy path** → 201; NftTransactionDetail row created; Asset.balance NOT touched (NFTs don't affect token balances).
201. **POST sell** → 201; Asset.balance decreases. POST a buy first to give the asset a balance, then sell.
202. **POST transfer** → 201; Asset.balance UNCHANGED (transfer no-op per §1.3).
203. **POST connected portfolio** → 403 `CONNECTED_PORTFOLIO_READ_ONLY`.
204. **POST native with extra erc20 fields (tokenContractAddress)** → 400 `VALIDATION_ERROR` (strict, cross-shape).
205. **POST duplicate transactionHash** → 409 `TRANSACTION_HASH_DUPLICATE`.
206. **POST with unknown token symbol** → 400 `UNKNOWN_TOKEN_SYMBOL`.
207. **POST with symbol not in portfolio (no Asset row)** → 400 `ASSET_NOT_IN_PORTFOLIO`.

### GET list — 4 tests

208. **GET list with type filter** → 200; only native transactions returned.
209. **GET list with sort=timestamp,order=desc** → 200; newest first.
210. **GET list pagination** → 200; limit+offset honored.
211. **GET list of connected portfolio** → 200 (read allowed).

### GET detail — 3 tests

212. **GET native detail** → 200; full DTO with nativeDetail populated; erc20/nft detail null.
213. **GET erc20 detail** → 200; erc20Detail populated.
214. **GET non-existent transaction** → 404.

### PATCH — 5 tests

215. **PATCH direction (buy→sell)** → 200; Asset.balance recomputes (was +0.5, now -0.5, depending on history).
216. **PATCH amount** → 200; balance recomputes.
217. **PATCH symbol (token change)** → 200; OLD token's balance recomputes (loses this tx); NEW token's balance recomputes (gains it).
218. **PATCH with `type` field** → 400 `VALIDATION_ERROR` (type is immutable).
219. **PATCH connected portfolio's transaction** → 403.

### DELETE — 2 tests

220. **DELETE manual transaction** → 200; transaction row gone; child detail gone via cascade; Asset.balance recomputes.
221. **DELETE connected portfolio's transaction** → 403.

### Balance recalc cascade — 2 tests

222. **Full lifecycle**: POST buy 1 BTC → balance=1.0; POST buy 0.5 BTC → balance=1.5; POST sell 0.3 BTC → balance=1.2; DELETE the first buy → balance=0.2 (sell still applies but balance can go negative — accept that for MVP); document the negative-balance edge case.
223. **Portfolio totalValue includes transaction-derived balances**: portfolio with 1 BTC (via buy transaction) returns totalValue = 1 × 93000 = 93000.

### Schema delta confirmation — 1 test

224. **transaction_direction seed**: `prisma.transactionDirection.count()` returns 3; the three names are `['buy', 'sell', 'transfer']`.

Total new tests: 27. After Stage 9A: ~224 tests.

## 6. STOP-AND-ASK gates

1. **If the schema migration fails on Neon** (e.g., a permissions error or the SQL syntax flagged), STOP and report the actual error. The pattern from Stage 1A/3B has been reliable; new failures are rare but worth surfacing.
2. **If existing Stage 7 portfolio tests or Stage 8 asset tests fail** after the transactions router mounts (cleanup-order issue?), STOP and investigate. The fix is usually the `beforeEach` cleanup order.
3. **If recalcAssetBalance produces a negative balance** for an asset (sell exceeds buy history), surface this as a known limitation — Stage 9A accepts negative balances as an MVP simplification. Real product would either reject (HTTP 400) or model short positions explicitly; out of scope here.
4. **If the discriminated union Zod schema makes for messy type inference** in the service layer, iterate locally; don't fall back to a single non-strict schema.

## 7. What NOT to do

- **No NFT balance accounting.** NFTs are tracked by ownership state in the `Nft` table (Stage 12), not by quantity-based balance.
- **No transfer balance effect.** Transfer = no-op per §1.3.
- **No mutating `type` or `transactionHash` via PATCH.** Both are immutable.
- **No Moralis integration.** Stage 11 owns the connected-portfolio sync.
- **No automatic asset creation from a transaction.** User must POST /assets first (§1.3 path b).
- **No Redis cache writes for PnL.** Stage 13's snapshots own the cache. Stage 9A doesn't touch Redis at all (except potentially the cache-invalidate stub, which Stage 13 will activate).
- **No transactions in the GET-list child-detail response.** List is base-only; detail is heavy.
- **No editing the schema docx.** Surface as doc-fix items.
- **No `npm audit fix`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(transactions): Stage 9A — polymorphic CRUD + balance recalc + transaction_direction schema delta"
git log --oneline -5
```

Report:
- New commit SHA.
- The migration applied (`<ts>_transaction_direction`) — confirm `prisma migrate status` shows it as applied.
- The three transaction_direction seed rows exist.
- One curl per endpoint, including the connected-portfolio rejection.
- Vitest output: all tests passing (count ~224+).
- Confirmation Asset.balance reflects transaction history after POST/PATCH/DELETE.
- Confirmation PnL fields on PortfolioDTO and AssetDTO still serialize as 0 (no Stage 13 work happened).
- Doc-fix pile items added in Stage 9A:
  - `Neonfi Database Schema.docx`: add `TransactionDirection` lookup model + `Transaction.direction` FK column.
  - `Neonfi System Architecture.docx` Transaction Module: clarify transfer-is-no-op for MVP balance recalc semantics.
- Anything unexpected (especially the negative-balance edge case if it surfaces in tests).

If blocked: output the question, stop, wait. Do not invent.
