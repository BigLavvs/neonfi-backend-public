# Neonfi backend — Stage 6: Tokens module (+ toUserDTO cleanup)

This file is the source-of-truth intent for Stage 6. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 5 landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-5.md` (this repo). Stage 6 reuses patterns from every prior stage: module skeleton, `requireAuth`, the `getEffectivePlan` helper Stage 5 extracted into `subscriptions.service.ts`, the empty-string Hono sub-router root-route convention (`router.get('', ...)`).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 6 in §3 in full**, **§2.4 Pagination** (read this CAREFULLY — Stage 6 is the ONLY cursor-paginated endpoint in the entire backend), **§0.4 locked decisions**.
3. `Neonfi System Architecture.docx` — **TOKEN** entity (URLs, resource rep, privacy rules), **Token Module** rules, **Pagination Standards** for the cursor format.
4. `prisma/schema.prisma` — `Token` model. The schema is unchanged for Stage 6; no delta.
5. The frontend code that consumes these endpoints:
   - `src/lib/components/modals/AddAssetModal.svelte` — calls `GET /tokens` for token search.
   - `src/lib/components/modals/AddTransactionModal.svelte` — same.
   - `src/lib/components/modals/NewPortfolioModal.svelte` — uses inline mock token data today (`mockPrice` field); replaced by `GET /tokens` calls.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Cursor pagination — the ONLY cursor-paginated endpoint [LOCKED by Build Guide §2.4]

Per Build Guide §2.4: "Cursor pagination (token list only): `?cursor=<last_token_id>&limit=20`; `meta: { limit, nextCursor }`."

Every other list endpoint in this codebase uses offset pagination. Token list is the exception because of infinite-scroll UX in the AddAsset modal. Get the contract exactly right — the frontend will rely on it.

**Cursor mechanics:**

- `cursor` is the `id` of the last token in the previous page. On the first request the cursor is omitted (`undefined` → `null`).
- `limit` is 1–50, default 20.
- Query: `prisma.token.findMany({ where: { id: { gt: cursor ?? 0 }, ...searchFilter, ...planFilter }, orderBy: { id: 'asc' }, take: limit + 1 })`.
- If `result.length > limit`: the last item is the "peek" — drop it from the response, set `nextCursor = result[limit - 1].id`.
- If `result.length <= limit`: `nextCursor = null` (no more pages).
- Response: `{ data: { tokens: [...] }, meta: { limit, nextCursor } }`. **No `total` field** — cursor pagination intentionally doesn't return a total count (expensive at scale, irrelevant for infinite scroll).

Order by `id ASC` always. Don't paginate by rank or any other field — the `id` ordering combined with `id > cursor` is what makes the cursor cheap and stateless.

### 1.2 Plan filtering — rank cap [LOCKED]

Per Build Guide §Functional Requirements: "Free tier: Up to 10 supported cryptocurrencies. Pro tier: 250+ supported cryptocurrencies."

This means free users see a **catalog of 10 tokens**, pro users see the full catalog. Not a per-user asset limit — that's Stage 8. This is a tier-limited token universe.

Implementation:
- Free users: add `where: { rank: { lte: 10 } }` to the listing query.
- Pro users: no rank cap (see everything in the Token table).
- For `GET /tokens/{id}`: free users can read any single token they know the ID of (no rank check on detail — once they see it in the list, they can read its detail). Stage 8's asset creation is where the "can't add a non-rank-10 token to your portfolio" enforcement lives. Stage 6's detail endpoint is permissive.

Use `getEffectivePlan(userId)` from `subscriptions.service.ts` to determine the cap. Mid-onboarding users get free-tier filtering (top 10).

### 1.3 Search — case-insensitive substring on name + symbol

Frontend search box hits `GET /tokens?search=<query>`. The search matches `name OR symbol` (case-insensitive substring).

Prisma: `where: { OR: [{ name: { contains: query, mode: 'insensitive' } }, { symbol: { contains: query, mode: 'insensitive' } }] }`. Note: `mode: 'insensitive'` requires the `Citext` extension OR Postgres ILIKE; Prisma handles it transparently for PostgreSQL via ILIKE under the hood. Should work on Neon out of the box.

Empty/missing `search` query → no filter applied (return the full catalog page).

Combine with `cursor` AND `planFilter` — all three `where` clauses AND together.

### 1.4 Token DTO — list vs detail [DIFFERENT SHAPES]

Per Build Guide §Stage 6 frontend contract: "Presentation layer expects token search to return `name, symbol, logoUrl, currentPrice, rank`, cursor-paginated. Detail rep adds `marketCap`, `updatedAt`."

So there are two DTO shapes:

**TokenListDTO** (returned in `GET /tokens`):
```ts
interface TokenListDTO {
  id: number;
  name: string;
  symbol: string;
  logoUrl: string | null;
  currentPrice: string;  // Decimal serialized as string to preserve precision
  rank: number | null;
}
```

**TokenDetailDTO** (returned in `GET /tokens/{id}`):
```ts
interface TokenDetailDTO extends TokenListDTO {
  marketCap: string | null;  // Decimal serialized as string
  updatedAt: Date;
}
```

`currentPrice` and `marketCap` are `Decimal` in the schema (precision 20,8 and 30,2 respectively per §0.4). Prisma returns them as `Decimal` objects; the safe serialization for JSON is `.toString()` — preserves precision, matches the architecture rep's numeric notation (the JSON number `93061.53` and the JSON string `"93061.53"` both round-trip; the frontend's `lib/api.ts` doesn't care which).

Pick **string serialization** for both — avoids any IEEE 754 precision concerns when `currentPrice` has 8 decimals. Document this choice in the DTO file with a comment. The frontend's existing mock data uses `string` already (`mockPrice: number` in modals, but the display format converts via `fmtUSD` which accepts both).

Actually re-check: the architecture rep shows numeric not string. The frontend's modal mock has `mockPrice: number`. To match the frontend's consumed shape exactly, serialize as number via `Number(decimal.toString())`. Acceptable precision loss for display purposes. Note in the DTO file that this is the chosen convention.

**Decision: serialize as `number`.** Match the existing frontend mock + architecture rep + all other Decimal fields in this codebase that the frontend touches. Document the precision trade-off in a code comment.

### 1.5 Vendor-agnosticism is deferred to Stage 9 [LOCKED]

Per Appendix item 2: "Moralis primary; CoinMarketCap / CoinRanking under evaluation pending a coverage spike on the 250+ list."

Stage 6's endpoints **do not call any vendor**. They read from the local `Token` table that Stage 9's metadata-sync job will populate. The vendor-decoupling concern lives in Stage 9.

For Stage 6, the only abstraction is the `tokens.repository.ts` that wraps Prisma queries. Don't add a "vendor adapter" interface here — that's premature and would conflate read-from-DB with fetch-from-API.

### 1.6 Dev seed — 30 popular tokens

Stage 1A explicitly skipped the token seed ("populated by Token Metadata Sync job, not hand-seeded, though a minimal dev seed is reasonable"). Stage 6 needs tokens in the DB for dev usability + test predictability. Add a **fixed list of 30 popular tokens** to `prisma/seed.ts` via upsert (idempotent on re-run).

Use these 30 (ordered by approximate rank — Stage 9's sync will overwrite/refresh as live data changes):

```ts
const TOKENS = [
  { name: 'Bitcoin',          symbol: 'BTC',   rank: 1,  currentPrice: '93000.00',     marketCap: '1850000000000.00' },
  { name: 'Ethereum',         symbol: 'ETH',   rank: 2,  currentPrice: '3200.00',      marketCap: '385000000000.00' },
  { name: 'Tether',           symbol: 'USDT',  rank: 3,  currentPrice: '1.00',         marketCap: '120000000000.00' },
  { name: 'BNB',              symbol: 'BNB',   rank: 4,  currentPrice: '610.00',       marketCap: '88000000000.00' },
  { name: 'Solana',           symbol: 'SOL',   rank: 5,  currentPrice: '165.00',       marketCap: '77000000000.00' },
  { name: 'USD Coin',         symbol: 'USDC',  rank: 6,  currentPrice: '1.00',         marketCap: '35000000000.00' },
  { name: 'XRP',              symbol: 'XRP',   rank: 7,  currentPrice: '0.62',         marketCap: '34000000000.00' },
  { name: 'Dogecoin',         symbol: 'DOGE',  rank: 8,  currentPrice: '0.38',         marketCap: '55000000000.00' },
  { name: 'Toncoin',          symbol: 'TON',   rank: 9,  currentPrice: '5.20',         marketCap: '13000000000.00' },
  { name: 'Cardano',          symbol: 'ADA',   rank: 10, currentPrice: '0.45',         marketCap: '16000000000.00' },
  { name: 'Avalanche',        symbol: 'AVAX',  rank: 11, currentPrice: '38.20',        marketCap: '15000000000.00' },
  { name: 'TRON',             symbol: 'TRX',   rank: 12, currentPrice: '0.16',         marketCap: '14000000000.00' },
  { name: 'Shiba Inu',        symbol: 'SHIB',  rank: 13, currentPrice: '0.000023',     marketCap: '13500000000.00' },
  { name: 'Polkadot',         symbol: 'DOT',   rank: 14, currentPrice: '7.10',         marketCap: '10000000000.00' },
  { name: 'Polygon',          symbol: 'MATIC', rank: 15, currentPrice: '0.91',         marketCap: '9500000000.00' },
  { name: 'Chainlink',        symbol: 'LINK',  rank: 16, currentPrice: '14.80',        marketCap: '9200000000.00' },
  { name: 'Bitcoin Cash',     symbol: 'BCH',   rank: 17, currentPrice: '440.00',       marketCap: '8700000000.00' },
  { name: 'Litecoin',         symbol: 'LTC',   rank: 18, currentPrice: '95.00',        marketCap: '7100000000.00' },
  { name: 'Cosmos',           symbol: 'ATOM',  rank: 19, currentPrice: '11.20',        marketCap: '4400000000.00' },
  { name: 'Uniswap',          symbol: 'UNI',   rank: 20, currentPrice: '8.90',         marketCap: '5300000000.00' },
  { name: 'Stellar',          symbol: 'XLM',   rank: 21, currentPrice: '0.13',         marketCap: '3600000000.00' },
  { name: 'NEAR Protocol',    symbol: 'NEAR',  rank: 22, currentPrice: '5.40',         marketCap: '5800000000.00' },
  { name: 'Filecoin',         symbol: 'FIL',   rank: 23, currentPrice: '5.80',         marketCap: '3200000000.00' },
  { name: 'Ethereum Classic', symbol: 'ETC',   rank: 24, currentPrice: '27.00',        marketCap: '4000000000.00' },
  { name: 'Hedera',           symbol: 'HBAR',  rank: 25, currentPrice: '0.082',        marketCap: '3000000000.00' },
  { name: 'Aptos',            symbol: 'APT',   rank: 26, currentPrice: '10.20',        marketCap: '4500000000.00' },
  { name: 'Arbitrum',         symbol: 'ARB',   rank: 27, currentPrice: '0.78',         marketCap: '3800000000.00' },
  { name: 'VeChain',          symbol: 'VET',   rank: 28, currentPrice: '0.040',        marketCap: '2900000000.00' },
  { name: 'Optimism',         symbol: 'OP',    rank: 29, currentPrice: '2.30',         marketCap: '2500000000.00' },
  { name: 'Maker',            symbol: 'MKR',   rank: 30, currentPrice: '1620.00',      marketCap: '1450000000.00' },
];
```

Symbol is `@unique` per schema — upsert by symbol. `logoUrl: null` for all (consistent with chains). Prices are placeholder values; Stage 9 sync overwrites with live data.

### 1.7 [BUNDLED CLEANUP] `toUserDTO` double-query elimination

Stage 5 extracted `getEffectivePlan(userId)` and `toUserDTO` adopted it — but `toUserDTO` already loads the subscription inline (for `billingCycle` + `status` + `currentPeriodEnd`) AND then calls `getEffectivePlan(user.id)` which loads the subscription AGAIN (for `plan` + `status`). Two reads per `/users/me` call where one suffices.

Cleanup: revert `toUserDTO` to use its OWN single subscription query that includes `plan`, `billingCycle`, AND `status`. Read the plan directly from the loaded row. Don't call `getEffectivePlan` here.

```ts
// users.repository.ts — toUserDTO
export async function toUserDTO(user: UserWithRelations): Promise<UserDTO> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    include: { plan: true, billingCycle: true, status: true },
  });

  const now = new Date();
  const effectivelyActive =
    subscription !== null &&
    (subscription.status.name === 'active' ||
      (subscription.status.name === 'cancelled' &&
        subscription.currentPeriodEnd !== null &&
        subscription.currentPeriodEnd > now));

  const plan = effectivelyActive ? subscription!.plan.name as 'free' | 'pro' : null;
  const billingCycle = effectivelyActive ? (subscription!.billingCycle?.name ?? null) : null;

  return {
    // ...other fields as before...
    plan,
    billingCycle,
  };
}
```

Remove the `import { getEffectivePlan }` from `users.repository.ts`. `getEffectivePlan` stays in `subscriptions.service.ts` — `chains.service.ts` is the sole caller, and that's the right place for the helper (no other reason to load subscription in chains.service).

All existing user-DTO assertions must continue to pass (plan/billingCycle null for verified-no-subscription, populated for active subscription, etc.). Run the auth + users tests as a sanity check before moving to tokens.

## 2. Module scope

```
src/modules/tokens/tokens.controller.ts       # NEW — mounts at /api/v1/tokens
src/modules/tokens/tokens.service.ts          # NEW — list + read by id with plan/cursor/search logic
src/modules/tokens/tokens.repository.ts       # NEW — findManyTokens, findTokenById
src/modules/tokens/tokens.schemas.ts          # NEW — Zod for list query
src/modules/tokens/tokens.dto.ts              # NEW — toTokenListDTO + toTokenDetailDTO
src/modules/tokens/tokens.constants.ts        # NEW — the 30-token list for seed import
src/modules/users/users.repository.ts         # EDIT — bundle cleanup §1.7
prisma/seed.ts                                # EDIT — add 30-token upsert loop
src/app.ts                                    # EDIT — mount /api/v1/tokens
tests/tokens.test.ts                          # NEW — ~12 tests
tests/users.test.ts                           # NO CHANGES expected, but VERIFY all 14 still pass after §1.7 cleanup
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `GET /tokens` — cursor-paginated, searchable, plan-filtered

**`requireAuth` middleware required.** Query (Zod, all optional):

- `cursor` — non-negative integer; defaults to no cursor (page 1).
- `limit` — integer 1–50, default 20.
- `search` — string 1–100 chars, optional.

**Flow:**

1. Validate query. Bad input → `400 VALIDATION_ERROR`.
2. Determine effective plan via `getEffectivePlan(user.id)`.
3. Build the `where` clause:
   - `id: { gt: cursor ?? 0 }` (always)
   - `rank: { lte: 10 }` if `effectivePlan === 'free'`
   - `OR: [{ name: { contains: search, mode: 'insensitive' } }, { symbol: { contains: search, mode: 'insensitive' } }]` if `search` provided
4. Query: `prisma.token.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 })`.
5. If result length > limit: drop the last item (the peek), set `nextCursor = items[limit - 1].id`. Else: `nextCursor = null`.
6. Map each through `toTokenListDTO()`.
7. Respond: `200 { data: { tokens: [...] }, meta: { limit, nextCursor } }`.

### 3.2 `GET /tokens/{id}` — token detail

**`requireAuth` middleware required.** Path param: `id` (positive integer; validate).

**Flow:**

1. Parse `id`. Invalid → `400 VALIDATION_ERROR`.
2. `prisma.token.findUnique({ where: { id } })`.
3. If not found → `404 TOKEN_NOT_FOUND`. (Detail endpoint can use a real 404; cross-user enumeration isn't a concern because tokens aren't user-owned.)
4. **No plan check on detail.** Once a user has the ID (got it from a list response, or knows it externally), they can read the detail. Plan-gating on the LIST is what limits exposure.
5. Map through `toTokenDetailDTO()`.
6. Respond: `200 { data: { token: <TokenDetailDTO> } }`.

## 4. Cross-cutting wiring

### 4.1 Seed update

Modify `prisma/seed.ts` to add token seeding (after chains, before the final log line). Import `TOKENS` from `src/modules/tokens/tokens.constants.ts`. Upsert by `symbol` (which is `@unique` per schema):

```ts
for (const token of TOKENS) {
  await prisma.token.upsert({
    where: { symbol: token.symbol },
    update: {
      name: token.name,
      rank: token.rank,
      currentPrice: token.currentPrice,
      marketCap: token.marketCap,
    },
    create: { ...token, logoUrl: null },
  });
}
```

Update the final `console.log` to acknowledge `token` is now seeded with the dev fixture, with a note that Stage 9 sync extends/refreshes.

### 4.2 Mount the tokens router

In `src/app.ts`:

```ts
import { tokensRouter } from './modules/tokens/tokens.controller.js';
// ...
api.route('/tokens', tokensRouter);
```

Sub-router root route: `router.get('', requireAuth, ...)` per the empty-string convention (Stage 5 §1.5).

### 4.3 Bundled cleanup — `toUserDTO` single-query

Per §1.7. Verify all 14 users tests still pass + all 34 auth tests still pass after the change.

## 5. Tests (Vitest, integration — new file `tests/tokens.test.ts`)

Test numbering continues from Stage 5's 123.

Setup: `beforeEach` deletes `payment → subscription → session → user` (FK-safe order, same pattern as other tests). **Does NOT touch the token table** — tokens are seeded once via `npm run db:seed` and stay put across tests.

Add the email mock at the top (same boilerplate as every other test file).

124. **GET /tokens — free user (no cursor, no search)** → 200; `data.tokens` has 10 entries (free-tier cap), all with `rank` 1–10; `meta.limit: 20`, `meta.nextCursor: null` (the cap is the whole list).
125. **GET /tokens — pro user (no cursor, no search)** → 200; `data.tokens` has 20 entries (default limit); `meta.nextCursor` is the id of the 20th token; ordering by id asc.
126. **GET /tokens — pro user, page 2 (use nextCursor from #125)** → 200; `data.tokens` has 10 entries (the remaining 21–30); `meta.nextCursor: null`.
127. **GET /tokens — `?limit=5` as pro user** → 200; `data.tokens` has 5 entries; `meta.limit: 5`, `nextCursor` set.
128. **GET /tokens — `?limit=0`** → 400 VALIDATION_ERROR.
129. **GET /tokens — `?limit=100`** → 400 VALIDATION_ERROR (max is 50).
130. **GET /tokens — `?search=bitcoin` as pro user** → 200; matches by name; results include Bitcoin (rank 1) and Bitcoin Cash (rank 17). Free user with same search → matches Bitcoin only (Bitcoin Cash is rank 17, outside free tier).
131. **GET /tokens — `?search=BTC` (uppercase) as pro user** → 200; matches by symbol case-insensitively; returns Bitcoin.
132. **GET /tokens — `?search=xyz` (no matches)** → 200; `data.tokens: []`; `meta.nextCursor: null`.
133. **GET /tokens — no auth** → 401 UNAUTHENTICATED.
134. **GET /tokens/{id} — own existing token as free user, ID outside free tier** → 200 (no plan gate on detail per §1.2); returns full TokenDetailDTO.
135. **GET /tokens/{id} — non-existent id** → 404 TOKEN_NOT_FOUND.
136. **GET /tokens/{id} — invalid id (non-integer)** → 400 VALIDATION_ERROR.
137. **GET /tokens/{id} — no auth** → 401 UNAUTHENTICATED.

Bundled cleanup verification (these aren't new tests — just runs of existing ones):

- All 14 users tests pass after `toUserDTO` cleanup.
- All 34 auth tests pass.

**Total tests after Stage 6: 137** (34 auth + 14 users + 36 subscriptions + 13 webhooks + 10 payments + 5 plan-middleware + 8 chains + 14 tokens).

Note: tests 124–137 give 14 new tests, but the numbering above goes 124–137 = 14 entries. Confirm at commit time.

## 6. STOP-AND-ASK gates

1. **If `prisma db seed` runs but `prisma.token.count()` shows fewer than 30 rows after**, STOP — likely a unique constraint conflict or transaction issue. The upserts should be straightforward; if they're failing, investigate before continuing.
2. **If the existing 14 users tests fail after the §1.7 toUserDTO cleanup**, STOP and report the failing test names. The cleanup is supposed to be behavior-preserving.
3. **If Prisma's `contains` with `mode: 'insensitive'` doesn't work on Neon's Postgres (older Postgres without ILIKE support)**, fall back to manually constructing the WHERE clause with `Prisma.sql\`LOWER(name) LIKE LOWER(${query})\`` or similar. Note in the commit if this fallback was needed.
4. **If cursor + search returns inconsistent ordering** (e.g., search results aren't in id-ascending order), check that the orderBy is applied AFTER the where clauses. Prisma's ordering should be stable; if it's not, surface it.

## 7. What NOT to do

- **No vendor adapter / fetch from Moralis or CMC.** That's Stage 9's job. Stage 6 reads from the local `Token` table only.
- **No offset pagination on `GET /tokens`.** Cursor-only per Build Guide §2.4.
- **No `total` field in the `meta`.** Cursor pagination intentionally omits totals.
- **No filtering by query params other than `cursor`, `limit`, `search`.** No `?status`, no `?rank`, no `?chain` — those aren't part of the documented API.
- **No exposing `marketCap` or `updatedAt` in the list DTO.** Those are detail-only per architecture rep.
- **No mutations on tokens from user-facing endpoints.** Token table is read-only for users; populated by seed + Stage 9 sync.
- **No plan check on `GET /tokens/{id}` detail.** Plan-gating happens on the list only.
- **No introducing a separate `tokens.dev-seed.ts`** — keep the 30-token list in `tokens.constants.ts` and import into `seed.ts`. One source of truth.
- **No serializing `Decimal` as string in the DTO.** Use `Number(decimal.toString())` per §1.4 (matches frontend mock conventions). Document the precision trade-off.
- **No CDN / cache headers.** Per Build Guide §6.3 no CDN for authenticated data.
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(tokens): Stage 6 — cursor-paginated GET /tokens + GET /tokens/{id} + 30-token seed + toUserDTO cleanup"
git log --oneline -5
```

Report:
- New commit SHA.
- One curl per response variant: free user (10 tokens), pro user page 1 (20 tokens, nextCursor set), pro user page 2 (10 tokens, nextCursor null), search hit, detail.
- Vitest output: all **137 tests passing**.
- Confirmation `prisma db seed` is idempotent (re-run still shows 30 tokens, no duplicates).
- Where `toTokenListDTO` and `toTokenDetailDTO` live.
- Confirmation `toUserDTO` now does ONE subscription query (not two). Note in the commit message that the §1.7 cleanup was bundled.
- Doc-fix pile items added in Stage 6:
  - `Neonfi System Architecture.docx` Token resource rep: confirm `currentPrice` and `marketCap` numeric serialization convention (number vs string) — backend serializes as number; doc shows quoted; pick one and align.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
