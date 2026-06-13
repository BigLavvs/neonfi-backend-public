# Neonfi backend — Stage 7: Portfolios module

This file is the source-of-truth intent for Stage 7. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 6 landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-6.md` (this repo). Stage 7 reuses every prior pattern — `requireAuth`, plan resolution via `getEffectivePlan`, the empty-string Hono sub-router root-route convention, the FK-safe cleanup order in tests (`payment → subscription → session → user`), Zod `.strict()` for body validation, the Neon-shadow-DB migration workaround if a schema delta becomes necessary (Stage 7 should NOT need one).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 7 in §3 in full**, **§0.4 locked decisions** (derived values never stored), **§2.4 Pagination** (portfolios are offset-paginated), **§2.5 Caching** (PnL/portfolio-value Redis 5-min TTL — establish the cache key pattern here even though the values stay 0 until Stage 13).
3. `Neonfi System Architecture.docx` — **PORTFOLIO** entity (URLs, resource rep, privacy rules), **Portfolio Module** rules (especially the "PnL never stored" rule).
4. `prisma/schema.prisma` — `Portfolio`, `PortfolioType`. The schema is unchanged for Stage 7; no delta.
5. The frontend code that consumes these endpoints:
   - `src/lib/components/modals/NewPortfolioModal.svelte` lines 281 + 339 — calls `POST /portfolios` for both connected and manual paths. Read these to confirm the request bodies the backend must accept.
   - `src/lib/components/modals/ManagePortfoliosModal.svelte` lines 41 + 59 — calls `PATCH /portfolios/{id}` and `DELETE /portfolios/{id}`.
   - `src/routes/(dashboard)/dashboard/+page.ts` — the dashboard load function. Reads `GET /portfolios` once and derives both the portfolio list AND the dashboard aggregate totals from the same response. This is the canonical example of "don't add a /portfolios/summary endpoint" (Build Guide §Stage 7 Divergence Watch).
   - `src/routes/(dashboard)/wallet/[portfolioSlug]/[tokenSlug]/+page.ts` — uses slugs in routes. Slugs resolve to IDs via the GET /portfolios response (which must include a `slug` field per §1.2 below).

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Discriminated-union request body for POST [LOCKED]

`POST /portfolios` has two completely different shapes depending on `type`:

```ts
// type='connected' — wallet-linked portfolio, synced by Moralis (Stage 11)
{ type: 'connected', name: string, walletAddress: string, chainId: number }

// type='manual' — user logs everything by hand
{ type: 'manual', name: string, startingBalance?: string }
```

Use Zod `z.discriminatedUnion('type', [...])` with `.strict()` on each member. Cross-shape fields are REJECTED:
- `type: 'connected'` with `startingBalance` field → 400 VALIDATION_ERROR.
- `type: 'manual'` with `walletAddress` or `chainId` → 400 VALIDATION_ERROR.

`startingBalance` is the user's claimed "starting amount" for manual-portfolio PnL baseline. Schema column is `Decimal(20,8) NULL`. Accept as string (Zod regex `^\d+(\.\d+)?$`), Prisma converts to Decimal on insert. For connected portfolios it stays null.

The frontend's `NewPortfolioModal.svelte:339` actually sends `{ type:'manual', name, assets }` (with an `assets` array) — IGNORE the `assets` field if present (don't 400 on it) so existing frontend code doesn't break, but DO NOT create Asset rows from this endpoint. Asset creation is Stage 8's responsibility. Document this decision in the controller comment.

Wait — `.strict()` would 400 on unknown fields. Two options:
- (a) Use `.strict()` and reject `assets` → frontend must update.
- (b) Use `.strip()` (Zod default) on the manual variant only → `assets` silently dropped.

**Pick (a)** — strict everywhere. The frontend code is mock + TODO comments right now; it'll be rewritten when the real API binding lands. Forcing the frontend to send the documented shape is correct. Mention this in the doc-fix pile: "frontend `NewPortfolioModal.svelte:339` sends `assets` array on manual creation — the API rejects it; update the frontend to use POST /portfolios/{id}/assets after Stage 8."

### 1.2 Slug computation — derived, not stored; uniqueness enforced on (userId, name) [LOCKED]

The architecture rep doesn't have a slug field, and the schema has no slug column. The frontend uses slugs in routes (`/wallet/[portfolioSlug]/...`), so the PortfolioDTO must surface one. Compute it from the name:

```ts
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')  // drop non-alphanumeric
    .replace(/\s+/g, '-')           // spaces → dashes
    .replace(/-+/g, '-')            // collapse multiple dashes
    .replace(/^-|-$/g, '');         // trim leading/trailing dashes
}
```

If `slugify(name)` returns empty string (e.g., name is all special chars): reject with `400 INVALID_NAME` on create/update.

**Slug must be unique per user.** Enforce at the API layer (no schema delta — keep the schema docx clean): on `POST /portfolios` and `PATCH /portfolios/{id}` where `name` changes, check `prisma.portfolio.findFirst({ where: { userId, name: { equals: newName, mode: 'insensitive' } } })`. If a row exists (other than the one being updated): `409 NAME_TAKEN`.

PortfolioDTO exposes both `name` AND `slug` so the frontend can match-by-slug on the listing response.

This adds a doc-fix item: the `Neonfi System Architecture.docx` PORTFOLIO resource rep should include `slug: string` (computed). Surface in the commit.

### 1.3 Wallet address validation per chain [LOCKED]

Connected portfolios require `walletAddress` valid for the target chain. The 15 chains break into two address-format families:

- **14 EVM chains** (Ethereum, Polygon, BNB, Arbitrum, Optimism, Base, Avalanche, Fantom, Linea, zkSync Era, Polygon zkEVM, Cronos, Gnosis, Mantle): `0x` + 40 hex chars (case-insensitive). Regex: `/^0x[a-fA-F0-9]{40}$/`. Normalize to lowercase before storing.
- **1 non-EVM chain** (Solana): base58, typically 32–44 chars. Regex: `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/` (base58 alphabet excludes 0/O/I/l). Don't normalize case (base58 is case-sensitive).

Implementation: `src/modules/portfolios/wallet-validator.ts` exports `validateWalletAddress(address: string, chain: { slug: string }): { valid: boolean; normalized?: string }`. Switch on `chain.slug === 'solana'` for the non-EVM branch; everything else is EVM.

If validation fails: `400 INVALID_WALLET_ADDRESS` with `meta: { chainSlug }` so the frontend can show "That doesn't look like a Solana address" or similar.

### 1.4 Derived fields stay 0 until later stages — but the shape is established now [LOCKED]

Per Build Guide §0.4: "Derived values are never stored. PnL, totalValue, asset value/portfolioPercentage, analytics — all computed at query time from snapshots/assets and cached in Redis (PnL: 5-min TTL). They are not columns."

The PortfolioDTO surfaces these fields, but until Stages 8/10/13 populate the underlying data (assets, prices, snapshots), every derivation lands at 0:

```ts
interface PortfolioDTO {
  id: number;
  userId: number;
  name: string;
  slug: string;          // computed, §1.2
  type: 'connected' | 'manual';
  walletAddress: string | null;
  chainId: number | null;
  startingBalance: number | null;
  netDeposit: number;
  totalValue: number;           // sum of asset values — 0 until Stage 8 + Stage 10
  pnlAllTime: number;           // % — 0 until Stage 13 snapshots
  pnlAllTimeValue: number;      // absolute value, in same currency
  pnl24h: number;
  pnl24hValue: number;
  pnl7d: number;
  pnl7dValue: number;
  pnl30d: number;
  pnl30dValue: number;
  createdAt: Date;
  updatedAt: Date;
}
```

Implement the derivation as a function that takes the Portfolio row + (eventually) assets + snapshots. For Stage 7, the function returns all zeros for the derived fields. Wire the function so Stages 8/13 can extend it without changing the calling sites.

**Redis cache wiring**: establish the key pattern even though the cache is empty. Use `portfolio_pnl:<portfolioId>` with TTL 5 minutes. Stage 13's snapshot job will populate the cache; Stage 7's read path tries cache first, then computes (which is 0), then writes back. No real computation happens yet, but the wiring exists.

Wait — writing 0s to cache and then serving them looks "real" to the frontend, which is correct for the empty-portfolio case but could confuse later debugging. Better: only WRITE to cache when there's actual data to compute. For Stage 7 where every value is 0, just return 0 without touching Redis. Stage 13 will be where the cache becomes meaningful.

**Decision**: Stage 7's derivation function returns hardcoded zeros without touching Redis. Add a TODO comment naming Stage 13 as the point where the cache wiring becomes real.

### 1.5 Plan-count enforcement on POST [LOCKED]

Free users: 1 portfolio max. Pro users: 10 portfolios max.

Use `getEffectivePlan(userId)` to determine the cap. Mid-onboarding users (no subscription) → treated as free → 1 portfolio limit. (This is consistent with Stage 5's `/chains` treatment.)

On `POST /portfolios`:
1. Determine effective plan + cap.
2. Count user's portfolios: `prisma.portfolio.count({ where: { userId } })`.
3. If count >= cap: `403 PLAN_LIMIT_REACHED` with `meta: { current: count, limit: cap, plan: effectivePlan }`.

The cap is per the architecture's PLAN-BASED ACCESS CONTROL section. Do NOT enforce this on PATCH or anything else — only on creation.

### 1.6 Chain access enforcement on connected portfolio creation [LOCKED]

The 15 chains are also plan-tiered: free users can use 3, pro users can use all 15 (Stage 5). On `POST /portfolios { type: 'connected', chainId: X }`:

1. Resolve the chain by `chainId`. If not found: `400 INVALID_CHAIN`.
2. If user's effective plan === 'free' AND chain.slug is NOT in `FREE_TIER_CHAIN_SLUGS` (the Stage 5 constant): `403 PLAN_LIMIT_REACHED` with `meta: { chainSlug, plan: 'free' }`.

Import the constant from `src/modules/chains/chains.constants.ts`. Don't redefine it.

### 1.7 PATCH limits — name only [LOCKED]

`PATCH /portfolios/{id}` accepts ONLY `{ name: string }`. All other fields are immutable post-creation:

- `type` can't change (connected ≠ manual; the connected-portfolio sync is permanent).
- `walletAddress`, `chainId` can't change (the portfolio IS that wallet on that chain).
- `startingBalance` can't change (it's a one-time baseline).
- `netDeposit`, derived fields, timestamps — server-managed.

Zod schema: `z.object({ name: z.string().min(1).max(255) }).strict()`. Unknown fields → 400.

If `name` is unchanged from current: 200 no-op (returns current DTO).
If `name` causes a slug collision with another portfolio the same user owns: `409 NAME_TAKEN`.

### 1.8 DELETE cascade behavior [INHERITS FROM SCHEMA]

The schema has `Asset.portfolioId onDelete: Cascade`, `Transaction.portfolioId onDelete: Cascade`, etc. So deleting a portfolio deletes everything underneath. Use `prisma.portfolio.delete({ where: { id } })` and let the DB handle the cascade.

Response: `200 { data: { ok: true } }`. Don't return 204 — the codebase pattern is 200 + ok envelope.

### 1.9 Pagination on GET /portfolios — offset, but defaults are generous [LOCKED]

Per Build Guide §2.4 portfolios use offset pagination. The cap is 10 per user (Pro tier), so offset/limit are nearly moot — but the contract must still be honored:

- `limit` 1–50, default 50 (generous so the dashboard load always gets everything in one shot).
- `offset` ≥0, default 0.
- `meta: { limit, offset, total }`.

The frontend's dashboard load doesn't use pagination — it calls `GET /portfolios` once and gets everything because max is 10. Offset pagination is here for contract compliance.

## 2. Module scope

```
src/modules/portfolios/portfolios.controller.ts     # NEW — mounts at /api/v1/portfolios
src/modules/portfolios/portfolios.service.ts        # NEW — orchestration
src/modules/portfolios/portfolios.repository.ts     # NEW — Prisma queries
src/modules/portfolios/portfolios.schemas.ts        # NEW — Zod
src/modules/portfolios/portfolios.dto.ts            # NEW — toPortfolioDTO with derivation
src/modules/portfolios/wallet-validator.ts          # NEW — per-chain address regex
src/modules/portfolios/slug.ts                      # NEW — slugify helper
src/app.ts                                          # EDIT — mount /api/v1/portfolios
tests/portfolios.test.ts                            # NEW — ~22 tests
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `POST /portfolios` — create

**`requireAuth` middleware required.** Body per §1.1 (Zod discriminated union, `.strict()`).

**Flow:**
1. Validate body. Bad shape → `400 VALIDATION_ERROR`.
2. Plan-cap check per §1.5. Exceeded → `403 PLAN_LIMIT_REACHED`.
3. Slug check per §1.2. Empty slug → `400 INVALID_NAME`. Collision → `409 NAME_TAKEN`.
4. If `type === 'connected'`:
   - Resolve `chainId` to chain row. Not found → `400 INVALID_CHAIN`.
   - Plan-chain check per §1.6. Pro-only chain on free user → `403 PLAN_LIMIT_REACHED`.
   - Validate wallet address per §1.3. Bad format → `400 INVALID_WALLET_ADDRESS`.
   - Insert Portfolio with `typeId` → 'connected' row, `walletAddress` (normalized), `chainId`, `startingBalance: null`.
5. If `type === 'manual'`:
   - Insert Portfolio with `typeId` → 'manual' row, `walletAddress: null`, `chainId: null`, `startingBalance: <value> | null`.
6. Respond: `201 { data: { portfolio: <PortfolioDTO> } }`.

**Side effects for connected portfolios**: per Build Guide §Stage 7 "Moralis pulls assets/transactions/NFTs" — Stage 11 (Moralis webhook) is what actually performs the sync. Stage 7 does NOT trigger any Moralis API call. The portfolio gets created; the Stage 11 webhook will populate it asynchronously. Add a TODO comment naming Stage 11 as the trigger point.

### 3.2 `GET /portfolios` — list own portfolios (offset-paginated)

**`requireAuth` middleware required.** Query: `limit` (1–50, default 50), `offset` (≥0, default 0).

**Flow:**
1. Validate query.
2. `prisma.portfolio.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, take: limit, skip: offset, include: { type: true, chain: true } })`.
3. `prisma.portfolio.count({ where: { userId } })` for total.
4. Map each through `toPortfolioDTO()` — this is where the derived fields (PnL, totalValue) get computed (all 0 until later stages, per §1.4).
5. Respond: `200 { data: { portfolios: [...] }, meta: { limit, offset, total } }`.

### 3.3 `GET /portfolios/{id}` — read one

**`requireAuth` middleware required.** Path param `id` (positive integer; validate).

**Flow:**
1. Parse `id`. Invalid → `400 VALIDATION_ERROR`.
2. `prisma.portfolio.findUnique({ where: { id }, include: { type: true, chain: true } })`.
3. **Uniform 403** if not found OR `portfolio.userId !== currentUser.id` (no enumeration leak — same pattern as `DELETE /auth/sessions/{id}` and `GET /payments/{id}`).
4. Map through `toPortfolioDTO()`.
5. Respond: `200 { data: { portfolio: <PortfolioDTO> } }`.

### 3.4 `PATCH /portfolios/{id}` — update name

**`requireAuth` middleware required.** Path: `id`. Body per §1.7.

**Flow:**
1. Validate.
2. Find portfolio. Not found or wrong owner → `403 FORBIDDEN`.
3. If `name === current.name`: respond 200 with current DTO (no-op).
4. Slug-collision check: `prisma.portfolio.findFirst({ where: { userId, name: { equals: newName, mode: 'insensitive' }, id: { not: portfolioId } } })`. If row exists → `409 NAME_TAKEN`.
5. `prisma.portfolio.update({ where: { id }, data: { name: newName } })`.
6. Map and respond `200 { data: { portfolio: <PortfolioDTO> } }`.

### 3.5 `DELETE /portfolios/{id}` — delete (cascade)

**`requireAuth` middleware required.** Path: `id`.

**Flow:**
1. Validate.
2. Find portfolio. Not found or wrong owner → `403 FORBIDDEN`.
3. `prisma.portfolio.delete({ where: { id } })`. Schema cascades handle assets/transactions/NFTs/snapshots.
4. Respond: `200 { data: { ok: true } }`.

## 4. Cross-cutting wiring

### 4.1 Mount the portfolios router

In `src/app.ts`, after the tokens router:

```ts
import { portfoliosRouter } from './modules/portfolios/portfolios.controller.js';
// ...
api.route('/portfolios', portfoliosRouter);
```

Sub-router root route: `router.post('', ...)`, `router.get('', ...)` per the empty-string convention.

### 4.2 Derived fields helper — shared computation hook

Create `src/modules/portfolios/derive.ts` exporting `computeDerived(portfolio): DerivedFields` returning:
```ts
{
  totalValue: 0,
  netDeposit: 0,
  pnlAllTime: 0,
  pnlAllTimeValue: 0,
  pnl24h: 0,
  pnl24hValue: 0,
  pnl7d: 0,
  pnl7dValue: 0,
  pnl30d: 0,
  pnl30dValue: 0,
}
```

Stage 8 will extend this to actually sum asset values. Stage 13 will extend it to read PnL from snapshots. The signature stays stable. Mark with `// TODO(Stage 8): sum from assets. TODO(Stage 13): PnL from snapshots.`

For `netDeposit`: the schema has a `netDeposit` column with default 0. Read it from the portfolio row directly (not derived). The "0" you'd assume is actually the stored 0. Stage 9 (or earlier — let me check) — actually the schema has `netDeposit Decimal @default(0) @db.Decimal(20,8)` on Portfolio. So it IS stored. Read it from the row, convert Decimal to number.

So `netDeposit` is NOT derived; the other PnL/value fields ARE.

### 4.3 No Redis cache wiring yet

Per §1.4 decision: don't write 0s to Redis. The cache key pattern (`portfolio_pnl:<portfolioId>`) is reserved for Stage 13. Add a comment in `derive.ts` documenting this.

## 5. Tests (Vitest, integration — new file `tests/portfolios.test.ts`)

Test numbering continues from Stage 6's final count (137 or whatever it actually landed at — use the actual count from the previous commit).

Setup: same as other test files. Add the email mock at the top. Per-test cleanup: `payment → subscription → portfolio → session → user`. Note the portfolio truncation has to land BEFORE user (FK from portfolio.userId).

Helpers: extract a `createUserWithPlan(plan, opts)` helper if it's getting copy-pasted across files. For Stage 7 just inline it.

**Test list:**

1. **POST /portfolios manual — happy path** → 201; row exists in DB; type='manual', walletAddress=null, chainId=null, startingBalance=null; DTO has slug='my-main' for name='My main'.
2. **POST /portfolios manual with startingBalance** → 201; startingBalance stored as Decimal; DTO serializes as number.
3. **POST /portfolios manual with extra `assets` field** → 400 VALIDATION_ERROR (strict mode rejects).
4. **POST /portfolios connected — happy path with Ethereum** → 201; walletAddress normalized to lowercase; chainId set.
5. **POST /portfolios connected with invalid wallet address** → 400 INVALID_WALLET_ADDRESS; meta.chainSlug='eth'.
6. **POST /portfolios connected with Solana wallet (base58)** → 201; case preserved (not lowercased).
7. **POST /portfolios connected with non-existent chainId** → 400 INVALID_CHAIN.
8. **POST /portfolios connected as free user with Pro-only chain (e.g. Arbitrum)** → 403 PLAN_LIMIT_REACHED.
9. **POST /portfolios connected with `startingBalance` field** → 400 VALIDATION_ERROR (cross-shape leak).
10. **POST /portfolios manual with `walletAddress` field** → 400 VALIDATION_ERROR.
11. **POST /portfolios free user with 1 existing portfolio** → 403 PLAN_LIMIT_REACHED with meta.current=1, limit=1.
12. **POST /portfolios pro user with 10 existing portfolios** → 403 PLAN_LIMIT_REACHED with meta.current=10, limit=10.
13. **POST /portfolios with duplicate name (case-insensitive)** → 409 NAME_TAKEN.
14. **POST /portfolios with name that slugifies to empty** (e.g. name='!!!') → 400 INVALID_NAME.
15. **POST /portfolios no auth** → 401.
16. **GET /portfolios empty user** → 200; data.portfolios=[]; meta.total=0.
17. **GET /portfolios with 2 portfolios** → 200; ordered by createdAt asc; each DTO has slug + all derived fields (all 0).
18. **GET /portfolios with `?limit=1`** → 200; 1 item; meta.limit=1, total reflects all.
19. **GET /portfolios no auth** → 401.
20. **GET /portfolios/{id} own** → 200 with DTO.
21. **GET /portfolios/{id} another user's** → 403.
22. **GET /portfolios/{id} non-existent** → 403 (uniform).
23. **GET /portfolios/{id} no auth** → 401.
24. **PATCH /portfolios/{id} rename** → 200; name updated; slug recomputed.
25. **PATCH /portfolios/{id} rename to existing name (own other portfolio)** → 409 NAME_TAKEN.
26. **PATCH /portfolios/{id} rename to same name (no-op)** → 200 with current DTO; no DB write.
27. **PATCH /portfolios/{id} unknown field (e.g. type)** → 400 VALIDATION_ERROR.
28. **PATCH /portfolios/{id} another user's** → 403.
29. **DELETE /portfolios/{id} own** → 200; portfolio gone from DB; (any cascade — but Stage 7 has nothing under portfolios yet so just verify row removal).
30. **DELETE /portfolios/{id} another user's** → 403.
31. **DELETE /portfolios/{id} non-existent** → 403.
32. **PATCH /portfolios/{id} no auth** → 401.
33. **DELETE /portfolios/{id} no auth** → 401.

That's 33 tests. If existing tests have left the previous count at ~137, Stage 7 brings it to ~170. Confirm at commit time.

**Two extra integration-flavor tests worth adding:**

34. **Free user creates portfolio, upgrades to Pro, can create more** — verify the count check uses live plan, not stored. Pro upgrade → can now create up to 10 (or 9 more, since 1 already exists).
35. **Connected portfolio with Solana address** — round-trip the case-sensitive address through DB and back; verify no normalization corruption.

35 tests total for Stage 7.

## 6. STOP-AND-ASK gates

1. **If the EVM address regex needs adjustment** (e.g., your Moralis docs mention chain-specific quirks like Avalanche having a different format), STOP and surface. All 14 EVM chains in the seed should be 0x40-hex; if any aren't, the constant needs updating.
2. **If the slug computation produces collisions in non-obvious ways** (e.g., "My main" and "My Main!" both slugify to "my-main"), STOP — the uniqueness check on name (case-insensitive) should catch them, but if you find a case it doesn't, surface it.
3. **If the discriminated-union Zod schema struggles with `.strict()` per variant** (Zod has subtle behavior here), iterate locally; don't fall back to a single non-strict schema with manual post-parse checks.
4. **If `prisma.portfolio.findUniqueOrThrow` is the wrong API choice** for the ownership-check paths (it throws on not-found, which becomes 500 not 403), use `findUnique` + manual null check instead.
5. **If existing 137+ tests fail** after Stage 7 lands (especially auth/users), STOP. Stage 7 shouldn't touch those code paths.

## 7. What NOT to do

- **No `/portfolios/summary` aggregate endpoint.** The dashboard derives totals from the GET /portfolios response itself.
- **No PnL/totalValue/pnl* columns on the schema.** Always derived (§0.4).
- **No Moralis API call from Stage 7.** Connected portfolio creation just creates the row. Stage 11 handles sync.
- **No `assets` array creation from POST /portfolios.** Asset creation is Stage 8.
- **No Redis writes for derived fields.** All 0s until Stage 13 — don't pollute the cache with zeros.
- **No mutating `type`, `walletAddress`, `chainId`, `startingBalance` via PATCH.** Name only.
- **No 404 on cross-user or not-found ID lookups.** Uniform 403.
- **No CDN headers on portfolio responses.** Private authenticated data.
- **No introducing `slug` as a stored column** (no schema delta). Compute from name; uniqueness via name check.
- **No bypassing `getEffectivePlan`.** Use the helper for plan-cap and chain-tier checks.
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(portfolios): Stage 7 — CRUD + plan/chain enforcement + derived-field shape (PnL/totalValue stubbed at 0)"
git log --oneline -5
```

Report:
- New commit SHA.
- One curl per endpoint (create connected, create manual, list, detail, update name, delete).
- Vitest output: all tests passing (count expected to land around 170+).
- Confirmation derived fields all serialize as 0 in the DTO (PnL, totalValue, pnl24h, etc.).
- Confirmation `netDeposit` is read from the column (NOT derived), serializes as number.
- Confirmation no Redis writes happen during portfolio reads (cache wiring deferred to Stage 13).
- Doc-fix pile items added in Stage 7:
  - `Neonfi System Architecture.docx` Portfolio resource rep: add `slug: string` field.
  - `Neonfi System Architecture.docx` Portfolio: clarify that `type='manual'` POST body does NOT accept `assets` array — Asset creation is the Asset module's responsibility.
  - Frontend `NewPortfolioModal.svelte:339` currently sends `assets` array in manual create — needs update to use POST /portfolios/{id}/assets (Stage 8) after the API is wired.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
