# Neonfi backend — Stage 5: Chains module

This file is the source-of-truth intent for Stage 5. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `71234de` (Stage 4B — payments + refund + Hono sub-router quirk fix).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-4b.md` (this repo). Stage 5 is the first product-surface stage after the monetization layer closed. It reuses patterns from earlier stages: module skeleton (controller/service/repository/dto), `requireAuth`, the `toUserDTO`-style derivation pattern (here, plan-effective filtering), the Vitest setup (per-test cleanup, dev DB + Redis).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 5 in §3 in full**, **§2.4 Pagination** (chains is NOT paginated — small fixed list), **§0.4 locked decisions** re: lookup tables.
3. `Neonfi System Architecture.docx` — **CHAIN** entity (URLs, resource rep, privacy rules), **Chain Module** rules.
4. `prisma/schema.prisma` — `Chain` model. The schema is unchanged for Stage 5; no delta.
5. The frontend code that consumes this:
   - `src/lib/components/modals/NewPortfolioModal.svelte` and any onboarding step that selects a chain.
   - `(onboarding)/onboarding/+page.svelte` — calls `GET /chains` at onboarding step 3 (wallet path).

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 The 15 supported chains [LOCKED by Idowu]

Free-tier subset is the FIRST 3 by canonical id ordering. Pro tier sees all 15. The list and its ordering are server constants — seed them in `prisma/seed.ts` via upsert (idempotent on re-run).

```ts
const CHAINS = [
  { name: 'Ethereum',      slug: 'eth',           moralisId: '0x1',    logoUrl: null },
  { name: 'Polygon',       slug: 'polygon',       moralisId: '0x89',   logoUrl: null },
  { name: 'BNB Chain',     slug: 'bnb',           moralisId: '0x38',   logoUrl: null },
  { name: 'Arbitrum',      slug: 'arbitrum',      moralisId: '0xa4b1', logoUrl: null },
  { name: 'Optimism',      slug: 'optimism',      moralisId: '0xa',    logoUrl: null },
  { name: 'Base',          slug: 'base',          moralisId: '0x2105', logoUrl: null },
  { name: 'Avalanche',     slug: 'avalanche',     moralisId: '0xa86a', logoUrl: null },
  { name: 'Solana',        slug: 'solana',        moralisId: 'solana', logoUrl: null },
  { name: 'Fantom',        slug: 'fantom',        moralisId: '0xfa',   logoUrl: null },
  { name: 'Linea',         slug: 'linea',         moralisId: '0xe708', logoUrl: null },
  { name: 'zkSync Era',    slug: 'zksync',        moralisId: '0x144',  logoUrl: null },
  { name: 'Polygon zkEVM', slug: 'polygon-zkevm', moralisId: '0x44d',  logoUrl: null },
  { name: 'Cronos',        slug: 'cronos',        moralisId: '0x19',   logoUrl: null },
  { name: 'Gnosis',        slug: 'gnosis',        moralisId: '0x64',   logoUrl: null },
  { name: 'Mantle',        slug: 'mantle',        moralisId: '0x1388', logoUrl: null },
];
```

The free tier is the first 3 of this array (`eth`, `polygon`, `bnb`). The free-tier subset is determined by a server constant `FREE_TIER_CHAIN_SLUGS: readonly string[] = ['eth', 'polygon', 'bnb']` exported from the chains service or a `chains.constants.ts`. **DO NOT** store free-tier-ness on the schema (no column delta). The architecture rep doesn't expose it; it's a server-side filtering concern.

`moralisId` values are Moralis's standard chain identifiers — hex for EVM chains, lowercase string for Solana (Moralis Solana API uses a different identifier scheme). Stage 11 (Moralis webhook) consumes these.

`logoUrl` is left `null` for all 15 chains at MVP. The frontend renders a generic icon when null. Future polish: source from Logokit or a similar CDN; would be a doc-update item to architecture.txt (logoUrl is optional in the schema already).

### 1.2 Plan-effective filtering — server-side, no middleware [LOCKED]

`GET /chains` is callable mid-onboarding (the wallet-connect step is BEFORE plan selection in some flows). Using `requirePlan(['free', 'pro'])` would 403 mid-onboarding users with `SUBSCRIPTION_REQUIRED`. That's wrong here — they need to see chains to pick a wallet-connect path before committing to a plan.

Therefore: use `requireAuth` only. Inside the service, compute the effective plan:

```ts
async function getEffectivePlan(userId: number): Promise<'free' | 'pro'> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true, status: true },
  });
  if (!subscription) return 'free'; // mid-onboarding or pre-activation default
  const now = new Date();
  const effectivelyActive =
    subscription.status.name === 'active' ||
    (subscription.status.name === 'cancelled' &&
      subscription.currentPeriodEnd !== null &&
      subscription.currentPeriodEnd > now);
  if (!effectivelyActive) return 'free'; // expired Pro defaults to free
  return subscription.plan.name as 'free' | 'pro';
}
```

This mirrors the "effectively active" logic in `requirePlan` and `toUserDTO`. Lift it to a single helper in `src/modules/subscriptions/subscriptions.service.ts` (export `getEffectivePlan(userId)`) and import from there. Both `requirePlan` and `chains.service.ts` can use it. **DON'T duplicate the logic in three places** — refactor as part of this stage.

### 1.3 No pagination, no filtering by query

15 chains total. Always return the visible subset in a single response. No `?limit`, no `?offset`, no `?status` — small list, no pagination semantics needed. The response shape is:

```json
{ "data": { "chains": [<ChainDTO>, ...] } }
```

No `meta` field. (Build Guide §2.4 lists pagination targets — chains isn't one of them.)

### 1.4 Chain DTO

Per architecture.txt CHAIN resource rep:

```ts
interface ChainDTO {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  moralisId: string;
}
```

Five fields total. No FK ids exposed (the schema has none — Chain is a leaf entity).

### 1.5 Hono sub-router root-route convention — use empty string [LEARNED THE HARD WAY]

`router.get('/', ...)` mounted via `app.route('/chains', router)` does NOT match `/api/v1/chains` (without trailing slash) under Hono v4. Use `router.get('', ...)` for sub-router root routes. Stage 5's chains controller has only one route, and it's the root — `router.get('', requireAuth, ...)`. Tests call the path as `''` or `'?'` for query suffixes. Stage 3A and Stage 4B both hit this; it's a permanent pattern.

## 2. Module scope

```
src/modules/chains/chains.controller.ts       # NEW — mounts at /api/v1/chains
src/modules/chains/chains.service.ts          # NEW — getVisibleChains(userId)
src/modules/chains/chains.repository.ts       # NEW — listAllChains()
src/modules/chains/chains.dto.ts              # NEW — toChainDTO
src/modules/chains/chains.constants.ts        # NEW — FREE_TIER_CHAIN_SLUGS
src/modules/subscriptions/subscriptions.service.ts  # EDIT — export getEffectivePlan(userId)
src/modules/auth/plan.ts                      # EDIT — refactor to use getEffectivePlan
src/modules/users/users.repository.ts         # EDIT — toUserDTO uses getEffectivePlan
prisma/seed.ts                                # EDIT — add the 15 chains upsert
src/app.ts                                    # EDIT — mount /api/v1/chains
tests/chains.test.ts                          # NEW — ~8 tests
tests/auth.test.ts, users.test.ts             # EDIT — no changes expected, but verify pre-existing tests still pass after plan.ts / toUserDTO refactor
```

Do NOT touch any other module directory.

## 3. Endpoint

### 3.1 `GET /chains` — list chains visible to current user

**`requireAuth` middleware required.** No query params.

**Flow:**
1. Determine effective plan via `getEffectivePlan(user.id)`. Mid-onboarding / expired subscription / pre-activation user → `'free'`. Active free → `'free'`. Active or cancelled-in-period Pro → `'pro'`.
2. Load all chains: `prisma.chain.findMany({ orderBy: { id: 'asc' } })`. Order by `id` ensures Ethereum/Polygon/BNB are first (assuming seed inserts them in canonical order, which it does — see §1.1).
3. If effectivePlan === 'free': filter to `chain.slug in FREE_TIER_CHAIN_SLUGS`. If 'pro': return all.
4. Map each through `toChainDTO()`.
5. Respond: `200 { data: { chains: [<ChainDTO>, ...] } }`.

The free tier sees exactly 3 chains; Pro sees all 15. Always return them in id-ascending order so the frontend can rely on consistent ordering.

## 4. Cross-cutting wiring

### 4.1 Seed update

Modify `prisma/seed.ts` to add chain seeding. Use `prisma.chain.upsert({ where: { slug }, ... })` for each entry so re-running the seed is idempotent. Order matters — insert in the order from §1.1. Run after the lookup-table seeds.

Existing tests that have been passing assume no chains in the seed (chain seed was skipped at Stage 1A per Gate B). With chains now seeded, this gate is resolved. The user's `Neonfi System Architecture.docx` doc-fix pile gains: "Document the 15 supported chains list + the 3 free-tier members."

### 4.2 Refactor `getEffectivePlan` into a shared helper

Three places currently compute the same "effectively active" logic:
1. `src/modules/auth/plan.ts` (requirePlan middleware)
2. `src/modules/users/users.repository.ts` (toUserDTO)
3. (NEW for Stage 5) `src/modules/chains/chains.service.ts`

Lift the shared computation into `src/modules/subscriptions/subscriptions.service.ts` as `getEffectivePlan(userId): Promise<'free' | 'pro'>` (loads subscription, applies cancelled-but-in-period rule, returns 'free' as default for no-subscription/expired cases). Then:
- `requirePlan` uses it to check the plan list (and still needs the SUBSCRIPTION_REQUIRED logic for routes that genuinely need a subscription — keep that distinct from "effective plan").
- `toUserDTO` uses it to populate `plan` and `billingCycle`.
- `chains.service` uses it for filtering.

**Important:** `requirePlan` is stricter than `getEffectivePlan` returning 'free'. `requirePlan` checks for the EXISTENCE of an active subscription and 403s if absent (`SUBSCRIPTION_REQUIRED`). Don't conflate "effective plan = free" with "no subscription required." Keep the 403 paths intact:
- No subscription → 403 SUBSCRIPTION_REQUIRED (unchanged)
- Subscription expired → 403 SUBSCRIPTION_EXPIRED (unchanged)
- Plan not in allowed list → 403 PLAN_LIMIT_REACHED (unchanged)

`getEffectivePlan` is a SOFT version: "if asked which plan this user is effectively on for display/UX purposes, what's the answer?" It never 403s; it just returns 'free' for the edge cases. `requirePlan` keeps its hard checks; it can call `getEffectivePlan` internally only when the subscription is known to exist + be effectively active.

Actually the simplest refactor:
- `getEffectivePlan(userId)` for SOFT cases: chains, toUserDTO. Returns 'free' for no-sub.
- `requirePlan(allowed)` stays as-is, with its own subscription-loading + 403 logic. It does NOT call `getEffectivePlan`; the logic is similar but the response contracts differ. Light duplication is fine here.

Plan A: extract `getEffectivePlan` for soft cases only; leave `requirePlan` alone. Use it in chains.service and refactor toUserDTO to use it (replacing the inline logic). Skip the requirePlan refactor.

This is cleaner. Adopt Plan A.

### 4.3 Mount the chains router

In `src/app.ts`:

```ts
import { chainsRouter } from './modules/chains/chains.controller.js';
// ...
api.route('/chains', chainsRouter);
```

## 5. Tests (Vitest, integration — new file `tests/chains.test.ts`)

Test numbering continues from Stage 4B's 115.

Setup: `beforeEach` deletes `payment → subscription → session → user` (same FK-safe order as other test files). **Does NOT touch the chain table** — chains are seeded once via `npm run db:seed` and stay put across tests.

Add the email mock at the top (same boilerplate as other test files).

116. **GET /chains — free user (with active free subscription)** → 200; `data.chains` has exactly 3 entries; slugs are `['eth', 'polygon', 'bnb']` in that order.
117. **GET /chains — pro user (with active pro subscription)** → 200; `data.chains` has all 15 entries; ordering matches §1.1.
118. **GET /chains — mid-onboarding user (no subscription)** → 200; `data.chains` has exactly 3 entries (free-tier default).
119. **GET /chains — expired pro user** → 200; `data.chains` has exactly 3 entries (expired Pro defaults to free per §1.2).
120. **GET /chains — cancelled-but-in-period pro user** → 200; `data.chains` has all 15 entries (still effectively pro).
121. **GET /chains — no auth** → 401 `UNAUTHENTICATED`.
122. **GET /chains — DTO shape verification** → each chain has exactly the 5 fields `id, name, slug, logoUrl, moralisId`; no FK ids, no extra fields.
123. **Seed idempotency** → run `prisma db seed` twice in succession (programmatic) → `prisma.chain.count()` is 15 both times (no duplicates).

**Total tests after Stage 5: 123** (34 auth + 14 users + 36 subscriptions + 13 webhooks + 10 payments + 5 plan-middleware + 8 chains + 3 from prior unaccounted? — recount when committing).

Note: the seed-idempotency test (#123) is a meaningful one because Stage 5 introduces the chain seed; if anything's off in the upsert logic, that test catches it. Run it via importing the seed function or via `npx prisma db seed` in a child process; pick whichever is simpler.

## 6. STOP-AND-ASK gates

1. **If `prisma db seed` doesn't exist as a runnable script** (it should; Stage 1A wired it), STOP and report. The seed is required for tests to pass.
2. **If the existing 115 tests fail** after `toUserDTO` refactors to use `getEffectivePlan`, STOP. The user-DTO `plan`/`billingCycle` fields must continue producing the same values for all existing test paths.
3. **If you find the chain seed runs but the chains table still shows zero after**, STOP — likely a transaction/connection issue with Neon's serverless pooler. Use the Stage 4A pattern (`{ timeout: 15000 }` etc.) or split the upserts into smaller batches.

## 7. What NOT to do

- **No `isFreeTier` column on Chain.** Free-tier membership is a server constant, not schema.
- **No new env vars.** No new runtime deps.
- **No pagination on `GET /chains`.** It's 15 entries.
- **No filtering by query params.** `GET /chains?plan=pro` is wrong — server determines effective plan from the user's subscription.
- **No exposing `Chain.id` as a string in the DTO.** It's an integer (per §0.4); architecture rep shows it as a string but that's the architecture's pattern for IDs in JSON; we serialize as integer here and it works because JSON numbers and stringified ints both round-trip.

  Actually re-check: architecture.txt shows `"id": "123"` (quoted). The frontend reads what it gets. To match the docs literally, we should serialize ID as string. But every other DTO in this codebase returns `id: number`. Don't diverge — keep `id` as a number for consistency with the rest of the codebase, and surface this as a doc-fix item if the architecture rep needs to be relaxed.

- **No introducing a chain-by-id endpoint** (`GET /chains/{id}`). Architecture only specifies `GET /chains` as a flat list.
- **No mutating chain rows from any user-facing endpoint.** Chains are static, managed via seed only.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(chains): Stage 5 — GET /chains (plan-filtered) + 15 chain seed + getEffectivePlan refactor"
git log --oneline -5
```

Report:
- New commit SHA.
- One curl per response variant (free user / pro user / mid-onboarding user).
- Vitest output: all **123 tests passing**.
- Confirmation `prisma db seed` is idempotent (run twice, count remains 15).
- Where `getEffectivePlan` lives now (path), and which two files import it.
- Doc-fix pile items resolved in Stage 5: **Appendix item 1 (chain list + free-tier 3) is now LOCKED.**
- New doc-fix pile items added:
  - `Neonfi System Architecture.docx` Chain section: add the explicit 15-chain list with the 3 free-tier members called out (currently the architecture says only the count, not the membership).
  - `Neonfi System Architecture.docx` Chain resource rep: confirm `id` serialization convention (number vs string) — backend serializes as number, doc shows quoted string.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
