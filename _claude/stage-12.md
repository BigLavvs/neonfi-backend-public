# Neonfi backend — Stage 12: NFTs + 4 bundled fixes

This file is the source-of-truth intent for Stage 12. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: f56207a (Stage 11).

This prompt does TWO things:
- **Stage 12 main work** (§§1–5): NFT module endpoints + Nft schema delta for marketplace fields + activate Stage 11's deferred NFT handler.
- **Bundled fixes** (§6): 4 discrete fixes that have been accumulating. Independent of NFT work. Can land in a single commit alongside Stage 12 OR be split into separate commits at your discretion.

## 0. Read first

In this order:

1. `_claude/stage-7.md` (connected portfolio creation — bundled fix 6.1 extends this), `_claude/stage-8.md` (asset module pattern — Stage 12's NFT endpoints mirror this), `_claude/stage-11.md` (Moralis webhook with the deferred NFT handler — Stage 12 activates it).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 12 in §3 in full**, **§Functional Requirements** (NFT tracking is Pro-only; connected-portfolio-only), **§Plan-Based Access Control** (NFT access is the canonical Pro-gated read).
3. `Neonfi System Architecture.docx` — **NFT entity** (URLs, resource rep with the seven marketplace fields, Pro-only/connected-only privacy rules), **NFT Module** rules.
4. `prisma/schema.prisma` — `Nft` model. Currently has core fields (id, portfolioId, name, tokenId, contractAddress, collectionName, logoUrl, chain) + `@@unique([portfolioId, contractAddress, tokenId])`. **Missing the seven marketplace fields the architecture rep requires** — §1.1 fixes this.
5. `src/modules/webhooks/moralis-handlers.ts` — the deferred NFT handler from Stage 11 logs `moralis_nft_event_deferred` and no-ops. §1.2 activates it.
6. The frontend code that consumes these endpoints:
   - `src/lib/components/modals/NftDetailModal.svelte` — reads the marketplace fields per the architecture rep
   - `src/routes/(dashboard)/wallet/[portfolioSlug]/+page.svelte` — wallet NFT tab, Pro-gated client-side

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Schema delta — add 7 marketplace columns to Nft [LOCKED]

The architecture rep specifies these fields on the Nft response. The schema docx omits them. Same defect pattern as Session.refreshTokenHash, Subscription.scheduledPlanId, Transaction.directionId, etc.

Apply the schema delta via the established Neon-shadow-DB pattern:

**Migration SQL** (`prisma/migrations/<timestamp>_nft_marketplace_fields/migration.sql`):
```sql
ALTER TABLE "nft" ADD COLUMN "tokenStandard"  VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "floorPrice"     VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "floorPriceUsd"  VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "lastSale"       VARCHAR(50);
ALTER TABLE "nft" ADD COLUMN "lastSaleNote"   VARCHAR(100);
ALTER TABLE "nft" ADD COLUMN "rarity"         VARCHAR(100);
ALTER TABLE "nft" ADD COLUMN "traits"         JSONB;
```

All nullable. The Moralis webhook handler populates them when Moralis returns the data; the DTO returns null for any field not populated. Frontend renders conditionally per the architecture note "may be null when the provider does not return it."

Apply via:
```bash
npx prisma db execute --file prisma/migrations/<ts>_nft_marketplace_fields/migration.sql --url $env:DIRECT_URL
npx prisma migrate resolve --applied <ts>_nft_marketplace_fields
npx prisma generate
```

Update Prisma schema to add the seven fields with a NOTE comment explaining the architecture-vs-schema-docx divergence and naming this stage as the resolution point.

Add to the doc-fix pile: "`Neonfi Database Schema.docx` Nft model — add seven marketplace fields per Stage 12."

### 1.2 Activate Stage 11's deferred NFT handler [LOCKED]

Stage 11's `moralis-handlers.ts` logs `moralis_nft_event_deferred` and skips NFT transfers. Replace the deferred-log path with real handling:

```ts
// In handleNftTransfers (currently the deferred-log function):
for (const transfer of nftTransfers) {
  const direction = transfer.to.toLowerCase() === portfolio.walletAddress.toLowerCase()
    ? 'received'
    : 'sent';
  
  if (direction === 'received') {
    // Upsert Nft ownership. Moralis includes the marketplace fields when available.
    await prisma.nft.upsert({
      where: {
        portfolioId_contractAddress_tokenId: {
          portfolioId: portfolio.id,
          contractAddress: transfer.tokenAddress.toLowerCase(),
          tokenId: transfer.tokenId,
        },
      },
      create: {
        portfolioId: portfolio.id,
        contractAddress: transfer.tokenAddress.toLowerCase(),
        tokenId: transfer.tokenId,
        name: transfer.tokenName ?? null,
        collectionName: transfer.collectionName ?? null,
        logoUrl: transfer.logoUrl ?? null,
        chain: portfolio.chain?.slug ?? 'unknown',
        tokenStandard: transfer.tokenStandard ?? null,
        floorPrice: transfer.floorPrice ?? null,
        floorPriceUsd: transfer.floorPriceUsd ?? null,
        lastSale: transfer.lastSale ?? null,
        lastSaleNote: transfer.lastSaleNote ?? null,
        rarity: transfer.rarity ?? null,
        traits: transfer.traits ?? null,
      },
      update: {
        // refresh marketplace data if present
        floorPrice: transfer.floorPrice ?? undefined,
        floorPriceUsd: transfer.floorPriceUsd ?? undefined,
        lastSale: transfer.lastSale ?? undefined,
        lastSaleNote: transfer.lastSaleNote ?? undefined,
      },
    });
    processed++;
  } else if (direction === 'sent') {
    // Ownership transferred away; remove the Nft row
    await prisma.nft.deleteMany({
      where: {
        portfolioId: portfolio.id,
        contractAddress: transfer.tokenAddress.toLowerCase(),
        tokenId: transfer.tokenId,
      },
    });
    processed++;
  }
}
```

Important details:
- `contractAddress` stored lowercase for canonical comparison.
- `tokenId` is stored as VARCHAR (per the schema) since NFT token IDs can be very large integers (256-bit).
- `chain` is the slug ('eth', 'polygon', etc.) from the Portfolio's Chain relation; if missing, store 'unknown' rather than blocking.
- Marketplace fields aren't required from Moralis — if they're absent, store null (architecture-aligned).
- `sent` (OUT transfer) deletes the Nft row entirely. Connected portfolios reflect on-chain ownership; selling/sending an NFT removes ownership state.
- Idempotency: the @@unique constraint on (portfolioId, contractAddress, tokenId) means duplicate webhook deliveries upsert harmlessly.

The Stage 11 dispatch counters (`processed`, `skipped`, `deferred`) now report NFT events under `processed` (not `deferred`). The `deferred` counter goes to zero. Update Stage 11's tests if any assert `deferred > 0` for NFT events — they should now assert `processed`.

### 1.3 Pro-only + connected-portfolio-only on read endpoints [LOCKED]

Both NFT read endpoints require:
1. `requireAuth`
2. `requirePlan(['pro'])` — NFT data is Pro-only per architecture's Plan-Based Access Control. Free users get 403 PLAN_LIMIT_REACHED.
3. Portfolio-ownership middleware (nested-router pattern from Stage 8).
4. After portfolio is loaded: if `portfolio.type.name !== 'connected'` → return 200 with `data.nfts: []`. Manual portfolios can't have NFTs by design (no wallet address = no on-chain ownership state). Return empty list rather than 4xx — the frontend's wallet page checks this for the NFT tab visibility.

### 1.4 No pagination on NFT list [LOCKED]

Per-portfolio NFT count is small (Build Guide's free-pro split doesn't even mention an NFT count cap). Return all NFTs in a single response. No `?limit` or `?offset` params; no `meta.total`.

```json
{ "data": { "nfts": [<NftDTO>, ...] } }
```

Order by `createdAt DESC` (newest acquisitions first) so the wallet UI shows recent activity at the top.

### 1.5 No mutations from user-facing API [LOCKED]

NFTs are read-only via the API. Only Stage 11's webhook handler (via §1.2) writes to the Nft table. There's no POST/PATCH/DELETE on `/nfts/{id}`. The architecture rep doesn't even list mutation URLs — only `GET /portfolios/{id}/nfts` and `GET /portfolios/{id}/nfts/{id}`.

## 2. Module scope (Stage 12 main work)

```
src/modules/nfts/nfts.controller.ts     # NEW — nested router under /portfolios/:portfolioId/nfts
src/modules/nfts/nfts.service.ts        # NEW — listNfts, getNftById
src/modules/nfts/nfts.repository.ts     # NEW — findAllNftsByPortfolioId, findNftById
src/modules/nfts/nfts.dto.ts            # NEW — toNftDTO with the 14 fields (7 core + 7 marketplace)
src/modules/webhooks/moralis-handlers.ts  # EDIT — replace the deferred NFT logic with §1.2's upsert/delete logic
prisma/schema.prisma                    # EDIT — add the 7 marketplace columns + relations note
prisma/migrations/<ts>_nft_marketplace_fields/migration.sql  # NEW — hand-written
src/app.ts                              # EDIT — mount nested NFTs router
tests/nfts.test.ts                      # NEW — ~10 tests
tests/moralis-webhook.test.ts           # EDIT — update test 278 (NFT no longer deferred) + add NFT processing tests
```

Bundled-fix files in §6.

## 3. Endpoints

### 3.1 `GET /portfolios/{portfolioId}/nfts` — list NFTs

`requireAuth` + `requirePlan(['pro'])` + portfolio-ownership middleware.

**Flow:**
1. Portfolio loaded from middleware. If `type.name !== 'connected'`: respond `200 { data: { nfts: [] } }` immediately.
2. `prisma.nft.findMany({ where: { portfolioId }, orderBy: { createdAt: 'desc' } })`.
3. Map each through `toNftDTO()` (returns all 14 fields, null for unset marketplace data).
4. Respond: `200 { data: { nfts: [...] } }`.

### 3.2 `GET /portfolios/{portfolioId}/nfts/{id}` — NFT detail

`requireAuth` + `requirePlan(['pro'])` + portfolio-ownership middleware.

**Flow:**
1. Parse `id` (positive integer). Invalid → `400 VALIDATION_ERROR`.
2. Load Nft. If not found OR `nft.portfolioId !== portfolio.id`: `404 NFT_NOT_FOUND` (intra-user, no enumeration concern — user owns the portfolio).
3. Map through `toNftDTO()`.
4. Respond: `200 { data: { nft: <NftDTO> } }`.

## 4. Cross-cutting wiring

### 4.1 Mount the nested NFTs router

```ts
// src/app.ts
import { nftsRouter } from './modules/nfts/nfts.controller.js';
api.route('/portfolios/:portfolioId/nfts', nftsRouter);
```

### 4.2 NftDTO shape

```ts
interface NftDTO {
  id: number;
  portfolioId: number;
  name: string | null;
  tokenId: string;
  contractAddress: string;
  collectionName: string | null;
  logoUrl: string | null;
  chain: string;
  tokenStandard: string | null;
  floorPrice: string | null;
  floorPriceUsd: string | null;
  lastSale: string | null;
  lastSaleNote: string | null;
  rarity: string | null;
  traits: unknown | null;  // JSON; structure varies per marketplace
  createdAt: Date;
}
```

`traits` is `unknown` (or `Record<string, unknown>[]` if you want to be more precise) because Moralis's trait shape varies. The frontend renders whatever's there.

## 5. Tests (Vitest, integration — new file `tests/nfts.test.ts`)

Test numbering continues from Stage 11 (~280).

### Setup
Stage 11's test pattern: real DB + real Redis, register user, create connected Pro portfolio, seed Nft rows directly via prisma.nft.create for read tests.

### 10 new tests

281. **GET /nfts as Pro user on connected portfolio with 3 NFTs** → 200; data.nfts has 3 entries; newest-first ordering by createdAt.
282. **GET /nfts as Free user** → 403 PLAN_LIMIT_REACHED.
283. **GET /nfts on manual portfolio (Pro user)** → 200 with data.nfts: [].
284. **GET /nfts/{id} happy path** → 200 with full NftDTO; all 14 fields present (null for unset marketplace data).
285. **GET /nfts/{id} for another user's NFT (via portfolio middleware)** → 403 FORBIDDEN.
286. **GET /nfts/{id} non-existent** → 404 NFT_NOT_FOUND.
287. **GET /nfts/{id} as Free user** → 403 PLAN_LIMIT_REACHED.
288. **Marketplace fields populated** → seed an Nft with all 7 marketplace fields; DTO returns them; traits is parsed JSON.
289. **GET /nfts no auth** → 401 UNAUTHENTICATED.
290. **GET /nfts/{id} no auth** → 401.

### Updated/new moralis-webhook tests

In `tests/moralis-webhook.test.ts`, modify test 278 (currently asserts `deferred: 1` for NFT events). It now asserts NFT processing:

278 (replaces): **NFT transfer IN → Nft row upserted with marketplace fields populated when Moralis includes them**.

Plus 3 new moralis tests:

291. **NFT transfer OUT (sent) → Nft row deleted** (ownership transferred away from wallet).
292. **NFT transfer where Moralis omits marketplace fields** → Nft row created with marketplace columns NULL.
293. **NFT transfer idempotency** → same transfer twice → Nft row exists exactly once (upsert semantics via @@unique).

Total new tests: 14 (10 NFTs + 4 moralis updates/additions). After Stage 12 main work: ~294.

## 6. BUNDLED FIXES

These are 4 discrete improvements that have been accumulating. Each is independent of NFT work and of each other. Land them in the Stage 12 commit OR split into separate commits — your call.

### 6.1 Moralis Stream producer-side wiring [BUNDLED FIX]

**Problem**: Stage 7 creates connected Portfolio rows with `walletAddress + chainId` but doesn't register a Moralis Stream pointing at the wallet. Stage 11 built the consumer (webhook ingress) but in production the consumer will never receive events because no streams exist. Dev currently works via manually-configured streams in the Moralis dashboard pointing at test wallets.

**Fix**:
- New schema column on Portfolio: `moralisStreamId String?` (nullable VARCHAR(255)). Schema delta — apply via the Neon pattern.
- New file `src/lib/moralis-streams-client.ts` with:
  - `createStream(opts: { webhookUrl, chainId, address, description }): Promise<{ id: string }>`
  - `deleteStream(streamId: string): Promise<void>`
- Both call Moralis Streams REST API (`https://api.moralis-streams.com/streams/evm`) with `X-API-Key: <MORALIS_API_KEY>` header.
- In `src/modules/portfolios/portfolios.service.ts`, after a connected portfolio is created:
  - Call `createStream(...)` with webhookUrl `${API_BASE_URL}/api/v1/webhooks/moralis`.
  - Store the returned streamId on Portfolio.moralisStreamId.
  - On stream-create failure: log error, don't fail the portfolio creation. The Moralis sync just won't start; user can recreate later.
- In `deletePortfolio` (Stage 7): if `moralisStreamId` is set, call `deleteStream(streamId)` BEFORE deleting the Portfolio row. Stream cleanup prevents quota leaks. On stream-delete failure: log, continue with portfolio deletion.

**Tests**: extend `tests/portfolios.test.ts` to mock the Moralis Streams client and assert:
- POST /portfolios connected → createStream called once; moralisStreamId persisted.
- DELETE /portfolios → deleteStream called once with the stored streamId.

The actual Moralis Streams API shape may differ from this prompt's assumptions. If it does, surface as STOP gate 6 below. The architecture (interface + adapter pattern) stays the same; only the HTTP wiring changes.

### 6.2 Test cleanup migration to TRUNCATE ... CASCADE [BUNDLED FIX]

**Problem**: Cross-test contamination from per-test `prisma.X.deleteMany()` calls keeps causing intermittent failures in the full-suite runs. The deeper fix would be a separate Neon test branch + DATABASE_URL_TEST; the cheaper fix is TRUNCATE ... CASCADE on shared tables.

**Fix**:
- Add helper to `tests/helpers.ts`:
  ```ts
  export async function truncateAllUserData(): Promise<void> {
    await prisma.$executeRaw`TRUNCATE TABLE 
      "payment", "subscription", "transaction", 
      "nft", "asset", "portfolio", 
      "session", "user" 
      RESTART IDENTITY CASCADE`;
  }
  ```
  TRUNCATE is faster than DELETE and handles FK cascade automatically; RESTART IDENTITY resets sequences (which is what new tests want anyway).
- In every test file's `beforeEach`, replace the chain of `prisma.X.deleteMany()` calls with a single `await truncateAllUserData()` call.
- Lookup tables (auth_provider, plan, chain, token, etc.) are NOT touched by truncate — they stay seeded.
- Per-test Redis cleanup (`clearRedisAuthKeys()`) stays as-is.

After this migration, the full suite should be more reliable. Don't expect zero flakies forever — Neon cold-start P1001 errors still happen — but the FK-violation P2003 cascade failures should disappear.

**Files to edit**:
- `tests/helpers.ts` — add `truncateAllUserData`
- `tests/auth.test.ts`, `tests/users.test.ts`, `tests/subscriptions.test.ts`, `tests/portfolios.test.ts`, `tests/assets.test.ts`, `tests/transactions.test.ts`, `tests/payments.test.ts`, `tests/webhooks.test.ts`, `tests/moralis-webhook.test.ts`, `tests/chains.test.ts`, `tests/tokens.test.ts`, `tests/prices.test.ts`, `tests/ws.test.ts` — each replaces the deleteMany chain with the truncate call.
- `tests/token-sync.test.ts` and `tests/coinbase.test.ts` and `tests/health.test.ts` and `tests/plan-middleware.test.ts` — these don't touch user tables; no change needed.

If any test fails after the migration, the issue is usually an assumption about preserved state between tests (e.g., a `beforeAll` that seeded a user once and tests assumed it persists). Surface as STOP gate; don't paper over.

### 6.3 CMC_API_KEY required in Zod [BUNDLED FIX]

**Problem**: Stage 9B's CMC adapter is currently optional — if `COINMARKETCAP_API_KEY` is missing, the sync no-ops and the price-refresh endpoint degrades to cache-only. This was correct during dev but should be tightened before production.

**Fix**:
In `src/lib/config.ts` Zod schema:
```ts
// BEFORE
COINMARKETCAP_API_KEY: z.string().optional(),

// AFTER
COINMARKETCAP_API_KEY: z.string().min(1),
```

This forces the env var to be present at boot. If you want to keep dev-loose behavior (allow boot without the key for non-CMC dev work): make it required only when `NODE_ENV === 'production'` via a `.superRefine`. My recommendation: leave it strict — the cost of needing a dev CMC key is small, and dev-loose makes it easier to accidentally deploy without it.

Pick one approach and document in code comment.

### 6.4 Snapshot retention constant for Stage 13 [BUNDLED FIX]

**Problem**: Stage 13 (Snapshots, next) will need a `drop_chunks` retention window. Idowu locked **24 months** (730 days). Codify as a constant now so Stage 13 just imports it.

**Fix**:
- New file `src/lib/constants.ts`:
  ```ts
  /**
   * TimescaleDB snapshot retention window (Stage 13).
   * Drop balance_snapshot chunks older than this. Locked by Idowu at Appendix item 8.
   * Pro portfolios only — free portfolios never produce snapshots, so retention is moot for them.
   */
  export const SNAPSHOT_RETENTION_DAYS = 730;  // 24 months
  ```
- That's it for Stage 12. Stage 13 imports `SNAPSHOT_RETENTION_DAYS` and uses it in the drop_chunks SQL.

Resolves Appendix item 8 from the doc-fix pile.

## 7. STOP-AND-ASK gates

1. **If the Nft schema migration fails on Neon** (rare; the pattern has been reliable), surface the actual error.
2. **If existing Stage 11 NFT tests** (test 278's `deferred:1` assertion) break unexpectedly after the §1.2 activation, that's expected — update them to assert `processed:1`. If anything ELSE breaks, STOP and surface.
3. **If existing 280 tests fail after the §6.2 TRUNCATE migration**, STOP. The fix is usually an assumption about preserved state in one specific test file; investigate before continuing. If the failures are widespread (>10 tests), reverting the truncate migration and shipping it separately is acceptable — just say so.
4. **If `COINMARKETCAP_API_KEY` strict-required breaks the dev boot** (because your .env still has a placeholder or empty value), STOP and ask Idowu to provide a real key OR keep the var optional with a documented note.
5. **If Moralis Streams REST API shape (§6.1) differs significantly from this prompt's assumed call shape**, STOP. The interface stays; only the adapter implementation changes. Don't guess — point at the actual docs and surface.
6. **If you find an existing test asserts `prisma.nft.count() === 0` after a webhook flow** (Stage 11's test 278 used to assert this since NFT was deferred), update it. The new behavior is `prisma.nft.count() === 1` after a successful NFT IN transfer.

## 8. What NOT to do

- **No mutating Nft via user-facing API.** Only Moralis webhook writes (§1.5).
- **No NFT data on manual portfolios.** Return empty list (§1.3).
- **No pagination on NFT list.** Small per-portfolio counts.
- **No marketplace data hydration on read.** The webhook stores what Moralis returns; DTOs return what's stored. No on-demand Moralis fetches from the read endpoints.
- **No retry-with-backoff on Moralis Stream create/delete (§6.1).** Log and continue.
- **No CDN/HTTP caching headers on NFT endpoints.** Private authenticated data.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 9. Commit and report

Bundle Stage 12 main work + the 4 fixes in ONE commit OR split into 5 commits at your discretion. Recommended single-commit:

```bash
git add -A
git commit -m "feat(nfts): Stage 12 — NFT endpoints + Nft schema delta + Stage 11 NFT handler + 4 bundled fixes (Moralis stream producer, TRUNCATE test cleanup, CMC required, snapshot retention)"
git log --oneline -5
```

Report:
- New commit SHA(s).
- Confirmation 14 schema columns total (7 NFT marketplace + 1 Portfolio.moralisStreamId from §6.1) added via Neon migration pattern; `prisma migrate status` shows both migrations as applied.
- One curl per NFT endpoint (list happy path with marketplace fields, detail happy path, free user 403).
- Vitest output: all tests passing (~294 total).
- Confirmation Stage 11's NFT events now write Nft rows (test 278 updated; new tests 291–293 cover send/missing-fields/idempotency).
- Confirmation §6.2 TRUNCATE migration didn't regress any tests (all test files updated; full suite green).
- Confirmation `COINMARKETCAP_API_KEY` is now required at boot (Zod error message if missing).
- The exported constant `SNAPSHOT_RETENTION_DAYS = 730` exists in `src/lib/constants.ts`.
- Doc-fix pile items added in Stage 12:
  - `Neonfi Database Schema.docx` Nft model: add 7 marketplace fields (tokenStandard, floorPrice, floorPriceUsd, lastSale, lastSaleNote, rarity, traits).
  - `Neonfi Database Schema.docx` Portfolio model: add `moralisStreamId String?` column.
  - `Neonfi System Architecture.docx` Appendix item 8: mark "resolved — 24-month retention".
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
