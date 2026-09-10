# Neonfi Backend Build Guide

> **This is a derived, referential document. It is not a source of truth.**
> It sequences and orchestrates backend work by pointing at the authoritative
> documents. It does not make decisions. Where it appears to, that is a defect
> in this guide — flag it, do not follow it.

---

## Part 0 — How to use this document

### 0.1 Source-of-truth hierarchy

When two sources disagree, resolve in this order:

1. **`Neonfi_Database_Schema`** (Prisma schema) — authoritative for tables, columns, types, relations, enums-as-lookup-tables, cascade behavior, and uniqueness constraints.
2. **`Neonfi_System_Architecture`** — authoritative for endpoints, resource representations, privacy rules, module boundaries, plan enforcement, WebSocket/webhook contracts, caching, and API standards.
3. **`Neonfi_System_Implementation`** — authoritative for stack, hosting, environment variables, page definitions, onboarding state transitions, jobs, CI/CD, and repo structure.
4. **The frontend codebase** — authoritative for the *consumed* shape of every contract: cookie names, response shapes it reads, WebSocket message handling, route/query params, and the exact endpoints its load functions and TODOs name.
5. **This guide** — last. Routing and sequencing only.

**If this guide ever contradicts 1–4, the docs/code win. Stop, flag the conflict, and get it resolved in the authoritative source before writing code.** Do not silently follow the guide. Do not silently follow a "reasonable" instinct that contradicts the schema either.

### 0.2 Prime directive: divergence is worse than failure

A backend that fails loudly (won't compile, returns 500, fails a test) is recoverable in minutes. A backend that **functions but has silently diverged** from the architecture — a renamed field, an enum stored as a native Postgres enum instead of a lookup row, a cookie with the wrong name, a WebSocket payload one level too shallow — passes its own tests, ships, and breaks the frontend contract in production where it is expensive to trace.

The frontend is already built against these contracts. Every divergence you introduce is a bug you are shipping into code that already assumes the documented shape. **When in doubt, match the doc exactly, even if you would have designed it differently.**

### 0.3 The frontend mock-seam inventory

The frontend ships deliberate stubs that stand in for the backend. These are **not defects** — they are placeholders with a documented replacement. This table is the master list of what the backend must replace and where. Each row is traceable to a real file/line in the frontend codebase.

> **The single most dangerous category here is auth + plan gating.** The frontend currently *fakes* the entire plan-enforcement and session system client-side. The architecture is emphatic (`System_Architecture`: "Frontend plan checks are treated as UX enhancements only, not security enforcement"; "Authorization logic must not rely on frontend checks") that all of this must be enforced server-side. Treat every mock below as "UX placeholder only — real enforcement lives on the Hono backend."

| Mock seam (frontend) | File / line | What it currently does | What the backend replaces it with |
|---|---|---|---|
| `VITE_MOCK_AUTH` bypass in route guard | `hooks.server.ts:24–28` | Skips the session-cookie check entirely when `VITE_MOCK_AUTH=true` | Real session-cookie validation against `GET /users/me`; bypass removed in production (`.env` sets it `true` only in dev) |
| `VITE_MOCK_AUTH` bypass in dashboard layout | `(dashboard)/+layout.ts:13–21` | Returns a hardcoded `{ id:'dev', plan:'free', onboardingStatus:'complete' }` session | Real session populated by `hooks.server.ts` from the backend |
| `mockPro` store | `lib/stores/mockPro.ts:3–4` | Client-side boolean that fakes Pro entitlement; flipped by "Upgrade" buttons | **Nothing client-side.** Plan is read from the real session/subscription; entitlement enforced server-side on every gated endpoint |
| Pro "unlock" buttons | `ProGate.svelte:33`, `FeatureGateModal:13`, `AnalyticsGateModal:10`, `LimitReachedModal:13` | Call `mockProUnlocked.set(true)` | Real Stripe checkout (`POST /subscriptions` / `/subscriptions/upgrade`); entitlement flips only on confirmed Stripe webhook |
| Mock price map (dashboard) | `(dashboard)/dashboard/+page.svelte:175–179` | Hardcoded `{BTC:67420,…}` written into the `prices` store | Real prices: WebSocket `price_update` (Pro) or `POST /prices/refresh` (Free), served from Redis |
| Mock token list (modals) | `AddAssetModal.svelte:42`, `AddTransactionModal.svelte:44`, `NewPortfolioModal.svelte:20–29` | In-component arrays of tokens with `mockPrice` | `GET /tokens` (cursor-paginated search) and `GET /tokens/{id}` |
| Dashboard load mock data | `(dashboard)/dashboard/+page.ts:4,35,41,59,64` | Returns mock portfolios/analytics/transactions | `GET /portfolios`, `GET /analytics/{portfolioId}/summary`, `GET /portfolios/{portfolioId}/transactions?limit=5` |
| Wallet token-detail load | `(dashboard)/wallet/[portfolioSlug]/[tokenSlug]/+page.ts:38,45,51` | Throws `501 not implemented` | `GET /portfolios`, `GET /portfolios/{portfolioId}/assets?slug=…`, `GET /portfolios/{portfolioId}/assets/{tokenId}` |
| Payments load + actions | `payments/+page.ts:6,17`; `payments/+page.svelte:29,66` | Mock subscription + payments; cancel/refund are no-ops | `GET /subscriptions/me`, `GET /payments`, `POST /subscriptions/cancel`, `POST /subscriptions/refund` |
| Performance load | `performance/+page.ts:27` | Mock analytics | `GET /analytics/{portfolioId}/{summary,performance,holdings}` |
| Create/edit/delete portfolio | `NewPortfolioModal.svelte:280,338`; `ManagePortfoliosModal.svelte:40,58` | TODO comments naming the call | `POST /portfolios`, `PATCH /portfolios/{id}`, `DELETE /portfolios/{id}` |
| Add asset / transaction | `AddAssetModal.svelte:133`; `AddTransactionModal.svelte:201` | TODO comments; no network call | `POST /portfolios/{portfolioId}/assets`, `POST /portfolios/{portfolioId}/transactions` |
| Delete asset | `DeleteAssetModal.svelte:21` | No-op | `DELETE /portfolios/{portfolioId}/assets/{id}` |
| Logout | `LogoutConfirmModal.svelte:11` | Clears client state only | also `POST /auth/logout` to revoke the session server-side |
| WS ticket fetch | `(dashboard)/+layout.svelte:30–35` | `api.get('/auth/ws-token')`, falls through silently if it fails | Real `GET /auth/ws-token` returning `{ data: { token, expiresIn } }` |

**Reading note on env wiring (frontend, not a doc defect):** the frontend's REST base is `VITE_API_URL` and it calls bare paths (e.g. `${BASE}/users/me` in `hooks.server.ts:38`), with **no `/api/v1` segment in code**. `System_Architecture` mandates base path `/api/v1`. Therefore the version segment must be baked into the `VITE_API_URL` value (e.g. `https://api.neonfi.app/api/v1`). This is a deployment-wiring contract, not a code change. Flag it during integration.

### 0.4 Locked global decisions (recur everywhere)

These are already assumed by the schema, the docs, **and** the frontend. They are not yours to re-decide. Re-deciding any of them is the textbook silent divergence.

- **ID strategy: integer autoincrement.** Every model is `id Int @id @default(autoincrement())` (`Schema`, all models). **Not UUIDs.** (Note: `System_Architecture` Token-Handling prose now reads `session_id (integer, autoincrement)` after cleanup — consistent with schema.) Resource representations show `"id": "123"` as a string in JSON examples; treat the wire format per the architecture examples but the storage type is integer.
- **Enums are lookup tables, not native enums.** `AuthProvider`, `OnboardingStatus`, `Plan`, `BillingCycle`, `SubscriptionStatus`, `PaymentStatus`, `PortfolioType`, `TransactionType` are each a **table with `id` + `name` + relation** (`Schema`). They are seeded rows, joined by FK. Do **not** convert them to Prisma `enum`s — the frontend and API send/receive the `name` string (`"free"`, `"connected"`, `"native"`, …), and the schema resolves it to a row. See Part 1 seeds.
- **Naming: `@@map` to snake_case tables; camelCase fields.** Every model has `@@map("snake_case")` (`Schema`). Field names are camelCase in Prisma and in JSON. The DB columns are whatever Prisma maps them to; do not hand-rename.
- **Auth model: HttpOnly cookie for REST; short-lived ticket for WS.** Access/refresh tokens live in HttpOnly Secure SameSite cookies, sent automatically, never read by JS. The WebSocket is authorized by a single-use ticket from `GET /auth/ws-token` passed as `?token=`. Clients set **no** Authorization header. (`System_Architecture` API Standards → Auth; Security Architecture → Token Handling.) The frontend cookie is literally named `session` (`hooks.server.ts:30,39`).
- **Money: integer minor units.** `Payment.amount` is `Int` "in smallest currency unit e.g. cents" (`Schema:189`). Do not store decimals for payment amounts.
- **Crypto quantities: `Decimal(20,8)`; market cap `Decimal(30,2)`.** Balances, prices, gas fees, net deposits use `@db.Decimal(20,8)` (`Schema`). Never floats.
- **Plan enforcement is server-side, always.** Portfolio count, token count, chain count, NFT/analytics/snapshot/real-time access — all gated server-side per active plan (`System_Architecture` Plan-Based Access Control; Data Integrity). Frontend gating is UX only.
- **Derived values are never stored.** PnL, `totalValue`, asset `value`/`portfolioPercentage`, analytics — all computed at query time from snapshots/assets and cached in Redis (PnL: 5-min TTL). They are **not** columns. (`System_Architecture` Portfolio/Asset/Analytics notes; Portfolio Module rules.)
- **Validation: Zod, server-side, on every endpoint.** (`System_Architecture` API Security; `System_Implementation` Config Strategy.)
- **Response envelopes are fixed.** Success: `{ "data": …, "meta": … }`. Error: `{ "error": { "code", "message" } }`. No stack traces. (`System_Architecture` Request & Response Format.) The frontend reads `err.error.code/message` (`lib/api.ts`).
- **Module isolation.** Each module owns its tables; no cross-module direct DB queries; inter-module calls go through exposed services only. (`System_Architecture` Data Layer.)

---

## Part 1 — Foundations

Build order within this part is strict: **stack/config → schema/migrate → hypertable conversion → seeds.** Nothing in Part 3 runs until seeds exist, because every enum is a lookup row.

### 1.1 Stack & project setup

Anchored to `System_Implementation` Stack Summary and Repository Structure.

- **Runtime/framework/language:** Node.js + Hono + TypeScript.
- **Repo:** monorepo, `packages/backend` (the frontend already occupies `packages/frontend`). Backend internal layout is fixed by `System_Implementation` Repository Structure: `src/modules/{auth,users,subscriptions,portfolios,assets,transactions,nfts,tokens,chains,price,analytics,snapshots,webhooks,email}`, plus `src/jobs/{snapshot.job.ts,token-sync.job.ts}`, `src/ws/{server.ts,registry.ts}`, `src/lib/{redis.ts,prisma.ts,coinbase.ts}`, `src/index.ts`, `prisma/`.
- **Per-module internal shape** (`System_Implementation` Layer Separation Strategy): each module has services (business logic), repository/data-access functions, and domain rules. **Route handlers are controllers only** — parse/validate input, call a service, return the JSON envelope. They must not contain domain logic, direct DB queries, or cross-module orchestration.
- **Single shared client instances.** The Prisma client and the Redis client are each instantiated **once** for the process and imported everywhere (`lib/prisma.ts`, `lib/redis.ts` already exist in the repo tree for this). Never construct `new PrismaClient()` or a new Redis connection inside a request handler, service, or job — per-request instantiation exhausts the DB connection pool and opens redundant Redis sockets under load, directly undermining the <50k-concurrent-user target. This is a setup contract, not an optimization.
- **Hosting:** Hostinger VPS, deployed via **Coolify**. The backend (API + WS) runs as one Coolify resource (Docker container). **PostgreSQL + TimescaleDB is Neon** (managed, external — not on the VPS). **Redis is self-hosted as a Coolify container on the same VPS**, reached over the internal Docker network (never a public port). No load balancer, no sharding. (Stack migrated from the docs' original Render model; see §6.7/§6.8 for the operational consequences of self-managing.)

### 1.2 Environment & config

Anchored to `System_Implementation` §3 Required Environment Variables. Validate **all** required vars at startup with Zod; **fail startup if any are missing** (`System_Implementation` Configuration Strategy). The complete list lives in the doc — do not invent additions. Notable wiring:

- Core: `APP_BASE_URL`, `API_BASE_URL`, `NODE_ENV`.
- DB: `DATABASE_URL`, `DATABASE_URL_TEST`. (The doc's earlier `WDATABASE_URL` typo was corrected to `DATABASE_URL`.) **Neon-specific:** runtime uses the **pooled** connection string (`-pooler` host, PgBouncer) as `DATABASE_URL`; Prisma **migrations** require the **direct** (non-pooled) connection string as `DIRECT_URL` (set `directUrl` in the Prisma datasource). This is a Neon requirement, not in the original doc — wire both.
- Cache: `REDIS_URL`, `REDIS_URL_TEST`.
- Auth: `JWT_SECRET` (≥256-bit), `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY`, `COOKIE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_YEARLY_PRICE_ID`.
- Blockchain/token: `MORALIS_API_KEY`, `MORALIS_WEBHOOK_SECRET`, `COINBASE_WS_URL`, and (only if adopted, under evaluation) `COINMARKETCAP_API_KEY`, `COINRANKING_API_KEY`.
- Email: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`.
- Logging: `LOG_LEVEL`.

Production cookies: HttpOnly, Secure, `SameSite=Strict` (or `Lax` if frontend/backend are cross-origin) (`System_Implementation` Security Considerations).

### 1.3 Schema → migrations → hypertable

- The Prisma schema **is** `Neonfi_Database_Schema`. Reproduce it exactly. Do not "improve" types, relations, or `@@map` names.
- Run `prisma migrate` to create all relational tables.
- **TimescaleDB hypertable is a raw-SQL migration that runs *after* `prisma migrate deploy`** (`Schema` BalanceSnapshot note; `System_Implementation` ORM section + Deployment Flow): `SELECT create_hypertable('balance_snapshot', 'snapshot_date');`. Prisma defines `balance_snapshot` as a regular table; the conversion is external. The deploy step runs the conversion script if not already applied. **Neon constraint (changed from the docs' Render model):** Neon supports only the Apache-2 TimescaleDB feature set — basic hypertables and time-partitioning work, but **compression is NOT available** and is dropped from this build. The previously-specified "compression for rows older than 7 days" is therefore removed; **retention is handled by a scheduled `drop_chunks` job** (see §6.5), not by compression. Continuous aggregates are likewise unavailable on Neon — if analytics ever needs them, that is a design-time decision requiring a different Postgres host, not a Neon feature toggle. (`CREATE EXTENSION IF NOT EXISTS timescaledb;` must be run once on the Neon database before the hypertable conversion.)
- Indexing is mandatory: all PKs, all FK fields, and frequently queried fields (`email`, `walletAddress`, `symbol`, `portfolioId`) (`System_Architecture` Database Optimization).

### 1.4 Seed data — REQUIRED before anything runs

Because enums are lookup tables, these rows **must exist** or inserts referencing them fail. Seed values are taken verbatim from the `@@unique // …` comments in `Neonfi_Database_Schema`. Do not add, rename, or reorder values.

| Lookup table | `name` values to seed (exact) | Source |
|---|---|---|
| `auth_provider` | `email`, `google` | `Schema:53` |
| `onboarding_status` | `pending_verification`, `verified`, `plan_selected`, `complete` | `Schema:65` |
| `plan` | `free`, `pro` (each also has `pros[]` / `cons[]` string arrays) | `Schema:139,143,145` |
| `billing_cycle` | `monthly`, `yearly` | `Schema:155` |
| `subscription_status` | `active`, `cancelled`, `expired` | `Schema:167` |
| `payment_status` | `pending`, `succeeded`, `failed`, `refunded` | `Schema:209` |
| `portfolio_type` | `connected`, `manual` | `Schema:309` |
| `transaction_type` | `native`, `erc20`, `nft` | `Schema:385` |

Additionally seeded (data, not enums):

- **`chain`** — the supported chain list. Static, managed server-side (`System_Architecture` Chain entity/module). Each row needs `name`, `slug`, `logoUrl?`, `moralisId` (unique). The doc says 15 chains for Pro, 3 for free; **the specific 15 chains and which 3 are free-tier are not enumerated in any doc — this is design-time work.** Flag and decide before seeding; do not invent the list silently.
- **`token`** — populated by the Token Metadata Sync job (Part 3 Stage 9), not hand-seeded, though a minimal dev seed is reasonable.

> **Divergence Watch (seeds):** the most common silent break here is seeding a *different string* than the frontend sends — e.g. `cancelled` vs `canceled`, `connected` vs `wallet`, `erc20` vs `ERC20`. The frontend sends the exact lowercase strings above. Match them character-for-character.

---

## Part 2 — Cross-cutting contracts

Stated once; every stage in Part 3 inherits these. All anchored to `System_Architecture` → API Standards & Conventions unless noted.

### 2.1 Versioning & base path

- REST base path: `/api/v1`. WebSocket path: `/ws`. (Frontend bakes `/api/v1` into `VITE_API_URL`; see 0.3.)

### 2.2 Auth & session

- All protected endpoints require a valid access token, delivered via the HttpOnly `session` cookie (frontend cookie name: `session`). No Authorization header.
- Sessions are stateful refresh sessions in the `session` table, one per login, revocable server-side. Created only on `POST /auth/login` or `POST /auth/google`; there is no client-facing session-create endpoint (`System_Architecture` Session note).
- Google OAuth: validate the Google token server-side before issuing a Neonfi session; no password stored for Google users.
- WS authorization: `GET /auth/ws-token` returns `{ data: { token, expiresIn } }` — a single-use, 30–60s ticket. The WS handshake validates and **consumes** it. Invalid/expired/consumed → close code `4001`.

### 2.3 Response envelopes & errors

- Success: `{ "data": …, "meta": … }`. Error: `{ "error": { "code", "message" } }`. Never leak stack traces (generic errors in production).
- Plan-limit rejections use HTTP `403` with code `PLAN_LIMIT_REACHED` and a human message (`System_Architecture` Plan-Based Access Control).
- Invalid filters → `400` (`System_Architecture` Filtering).

### 2.4 Pagination, filtering, sorting

- **Offset pagination** (portfolios, assets, transactions, payments): `?limit=20&offset=0`; `meta: { limit, offset, total }`.
- **Cursor pagination** (token list only): `?cursor=<last_token_id>&limit=20`; `meta: { limit, nextCursor }`.
- Filtering via query params, e.g. `?type=erc20`, `?status=succeeded`, `?from=2026-01-01`. Sorting via `?sort=value&order=desc`.

### 2.5 Caching (Redis)

- Token prices: Redis, TTL 60s; never read prices from the DB.
- PnL / portfolio value: Redis, TTL 5 min; invalidate on new snapshot **or** new manual transaction.
- Token metadata: Redis, TTL 24h; invalidate on sync-job completion.
- Cache miss → DB query → write back to cache.

### 2.6 Idempotency

Three mandatory idempotency points (`System_Architecture` Idempotency Rules):

1. **Stripe webhook** — duplicate events must not create duplicate payments or state transitions.
2. **Moralis webhook** — duplicate wallet events must not create duplicate transactions.
3. **Snapshot job** — running twice in a day must not duplicate snapshots (enforced by `@@unique([portfolioId, snapshotDate])`, `Schema:503`).

### 2.7 WebSocket & Redis pub/sub contract

The single most contract-sensitive area. Exact message envelopes are in `System_Architecture` WebSocket section, and the **frontend already implements the consuming side** in `lib/ws.ts` — match it exactly.

- Typed envelope: `{ "type", "payload", "timestamp" }`.
- **Client → server (subscribe):** `{ "type": "subscribe", "payload": { "symbols": ["BTC","ETH"] } }` (`ws.ts:39`).
- **Server → client (price_update):** `{ "type": "price_update", "payload": { "symbol", "price", "change24h" }, "timestamp" }` (`ws.ts:51–52` reads exactly these payload keys).
- **Server → client (reconnect):** `{ "type": "reconnect", "payload": { "retryAfterMs", "reason" } }` (`ws.ts:67–70`).
- **Server → client (plan_downgraded):** `{ "type": "plan_downgraded", "payload": { "message" } }` → client tears down the socket (`ws.ts:72–73`).
- **Server → client (error):** `{ "type": "error", "payload": … }` (`ws.ts:74`).
- Close codes: `4001` invalid/expired/consumed ticket; `4003` Pro subscription expired mid-session (send `plan_downgraded` first, then close `4003`).
- Server maintains **one** persistent Coinbase connection for all Pro users; fan-out via Redis pub/sub to `symbol → [socketIds]` registry in Redis. Free users are rejected at handshake (`403`) and use `POST /prices/refresh`.

> **Divergence Watch (WS payload depth):** the price fields live **inside `payload`**, with `timestamp` as a sibling of `type`/`payload`. A flat `{ type, symbol, price }` will silently no-op the frontend (it reads `msg.payload.symbol`). This exact shape was a prior bug; do not reintroduce it.

### 2.8 Webhooks

- Stripe: verify `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`. Moralis: verify `x-signature` with `MORALIS_WEBHOOK_SECRET`. Unverified → `401`, no processing. Log every event with outcome. Detect duplicates by event ID.

### 2.9 Async / non-blocking

Email, token sync, snapshot job, Moralis sync, and Stripe state updates must run **outside** the request-response cycle (`System_Implementation` Asynchronous Processing). Commit the primary state change, return `200/201`, then run secondary work in background tasks with independent try/catch + logging.

---

## Part 3 — Feature stages

Stages are ordered so later ones depend only on earlier ones. Each stage lists: **what it implements · authoritative section · module · endpoints/contracts · flow · frontend contract · Divergence Watch.** Pseudocode appears only where genuinely tricky, and every block is marked **"shape, not gospel."**

### Stage 1 — Auth & session

- **Implements:** registration (email + Google), login, logout, email verification, session refresh/revocation, onboarding-status progression, and the WS ticket endpoint.
- **Authoritative:** `System_Architecture` USER + SESSION entities, Auth Module, Security/Auth Architecture; `System_Implementation` onboarding state transitions (`/register` page def).
- **Module:** `auth/` (owns nothing) + `users/` (owns User, Session).
- **Endpoints:** `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/google`, `POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /auth/refresh`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `GET /auth/ws-token`.
- **Flow:** register → create User with `authProvider` + `onboardingStatus=pending_verification` (email) or `verified` (Google) → send welcome + verification email async → on verify-link hit, transition `pending_verification → verified` server-side.
- **Frontend contract it must satisfy:**
  - `hooks.server.ts:38` calls `GET /users/me` with the `session` cookie and expects user JSON containing `id`, `onboardingStatus`, `plan`, `email`, and a name field. **The frontend reads `user.name ?? user.displayName` (`hooks.server.ts:61`)**, but the User resource rep defines `fullName` + `displayName` (no `name`). Resolve by returning `displayName` (frontend falls back correctly) — or flag to change the frontend. Do not invent a `name` column; it is not in the schema.
  - `GET /auth/ws-token` must return exactly `{ data: { token, expiresIn } }` (`(dashboard)/+layout.svelte:33`).
  - Onboarding status strings must be exactly the four seeded values; `hooks.server.ts:47–52` validates against that set and redirects on mismatch.
- **Divergence Watch:**
  - **Onboarding transitions are server-driven, triggered by *server events*, never client navigation** (`System_Implementation` Onboarding State Convention). Wiring `verified` to a page load or the path-selection screen is a divergence — the path-selection screen is UI-only and triggers no status change. `verified → plan_selected` fires on plan confirmation (free activation request, or Stripe webhook for Pro); `plan_selected → complete` fires immediately after plan confirmation; first-portfolio creation is **not** required to reach `complete`.
  - Cookie must be named `session` (frontend hardcodes it).
  - `authProvider` is a lookup-table FK, not a string column; resolve `email`/`google` to a row.
  - Session id is integer autoincrement (post-cleanup), not uuid.

### Stage 2 — Users / profile

- **Implements:** read/update own profile, newsletter toggle, account settings, change password (email users only), delete account.
- **Authoritative:** `System_Architecture` USER entity + Users Module; `System_Implementation` `/settings` page def.
- **Module:** `users/`.
- **Endpoints:** `GET /users/me`, `PATCH /users/me`.
- **Frontend contract:** `/settings` reads `data.user.authProvider === 'google'` to hide the password section (`settings/+page.svelte:28`). `GET /users/me` must return `authProvider` as the string `email`/`google` (resolved from the FK). `PATCH /users/me` updates `displayName`, `fullName`, `avatarUrl`, `newsletterSubscribed`.
- **Divergence Watch:** privacy rule — a user can only read/write their own record; others → `403`. `emailVerified` is in the User resource rep (added during reconciliation) — surface it; the onboarding wizard relies on verification state.

### Stage 3 — Subscriptions

- **Implements:** plan state, initial activation, upgrade, downgrade, cancel, refund.
- **Authoritative:** `System_Architecture` SUBSCRIPTION entity (esp. the activation-vs-upgrade note) + Subscription Module; `Schema` Subscription/Plan/BillingCycle/SubscriptionStatus.
- **Module:** `subscriptions/` (owns Subscription, Payment).
- **Endpoints:** `GET /subscriptions/me`, `POST /subscriptions`, `POST /subscriptions/upgrade`, `POST /subscriptions/downgrade`, `POST /subscriptions/cancel`, `POST /subscriptions/refund`.
- **Flow / semantics (verbatim from the doc — do not improvise):**
  - `POST /subscriptions` = **initial activation, once, during onboarding.** Free activates immediately in the same request; Pro returns a Stripe checkout URL and activates only on confirmed Stripe webhook.
  - `POST /subscriptions/upgrade` = subsequent changes on an existing subscription; handles free→pro and monthly→yearly; **takes effect immediately.**
  - `POST /subscriptions/downgrade` = pro→free and yearly→monthly; **takes effect at end of current billing period, not immediately.**
  - Cancel: remains active until period end, then portfolios beyond free limit become inaccessible (not deleted).
- **Frontend contract:** `/payments` reads `GET /subscriptions/me`; cancel/refund buttons call `POST /subscriptions/cancel` and `/subscriptions/refund` (`payments/+page.svelte:29,66`). Refund modal sends a reason in the body (`RefundConfirmModal.svelte:23`). `SubscriptionStatus` is `active | cancelled | expired` (no `past_due`).
- **Divergence Watch:**
  - **Plan transitions must only occur after a verified Stripe webhook for Pro — never on client assertion** (`System_Architecture` Subscription Module rules). Activating Pro in the `POST /subscriptions` response is a divergence; only Free activates synchronously.
  - Downgrade is deferred, upgrade is immediate — easy to wire both as immediate. Don't.
  - `billingCycle` is nullable (null for free) and is a lookup FK.

### Stage 4 — Payments & Stripe webhook

- **Implements:** payment records; the Stripe webhook that drives all paid state transitions idempotently.
- **Authoritative:** `System_Architecture` PAYMENT + PAYMENT WEBHOOK entities, Payment Webhook Module, Idempotency Rules, Webhook Conventions; `Schema` Payment/PaymentStatus.
- **Module:** `webhooks/` (Stripe receiver) writing through `subscriptions/`.
- **Endpoints:** `GET /payments`, `GET /payments/{id}`, `POST /webhooks/stripe` (server-only).
- **Frontend contract:** `/payments` reads `GET /payments`; `amount` is integer minor units; `status` is `pending|succeeded|failed|refunded`.
- **Divergence Watch:** signature verification mandatory on every request; unverified → `401` with no processing. Idempotency by Stripe event ID. `Payment.userId` is `onDelete: SetNull` (nullable) — preserve payment history when a user is deleted (`Schema:179–181`).

**Pseudocode — Stripe webhook idempotency & state transition** *(shape, not gospel — the schema/architecture wins on specifics)*:

```
POST /webhooks/stripe:
  rawBody = read raw request body            # needed for signature check
  verifySignature(rawBody, header['Stripe-Signature'], STRIPE_WEBHOOK_SECRET) else return 401
  event = parse(rawBody)

  if seenEventId(event.id): return 200        # idempotent: already processed
  markEventSeen(event.id)                      # atomic; survives retries

  match event.type:
    checkout/payment succeeded:
      in a DB transaction:
        upsert Payment(stripePaymentIntentId unique) status=succeeded
        transition Subscription -> active, set period start/end
        if onboarding: verified -> plan_selected -> complete   # server-driven
      after commit (async): send receipt + subscription-confirmation email
    payment failed:   set Payment.status=failed
    refund:           set Payment.status=refunded; send refund email async
  return 200
```

### Stage 5 — Chains

- **Implements:** supported-chain list, plan-gated.
- **Authoritative:** `System_Architecture` CHAIN entity + Chain Module; `Schema` Chain.
- **Module:** `chains/` (owns Chain).
- **Endpoints:** `GET /chains`.
- **Frontend contract:** used by the wallet-connect path in onboarding/new-portfolio (`System_Implementation` onboarding step 3 wallet path). Resource rep: `id, name, slug, logoUrl, moralisId`.
- **Divergence Watch:** free users restricted to 3 chains, Pro to 15 — enforced **on this endpoint** server-side. **The actual chain list is undefined in the docs (design-time work);** do not invent it. Static, server-managed.

### Stage 6 — Tokens

- **Implements:** cursor-paginated, searchable token list + token detail; populated by the sync job (Stage 9).
- **Authoritative:** `System_Architecture` TOKEN entity + Token Module, Pagination Standards; `Schema` Token.
- **Module:** `tokens/` (owns Token).
- **Endpoints:** `GET /tokens` (cursor), `GET /tokens/{id}`.
- **Frontend contract:** replaces the mock token arrays in `AddAssetModal`/`AddTransactionModal`/`NewPortfolioModal`. Presentation layer expects token search to return `name, symbol, logoUrl, currentPrice, rank`, cursor-paginated (`System_Architecture` Presentation Layer). Detail rep adds `marketCap`, `updatedAt`.
- **Divergence Watch:**
  - **Token list is the *only* cursor-paginated endpoint** — `meta: { limit, nextCursor }`, not offset. Using offset here diverges from the documented infinite-scroll contract.
  - Token count is plan-gated (10 free / 250+ pro) **on `GET /tokens`**.
  - Metadata source is **Moralis (primary); CoinMarketCap/CoinRanking under evaluation** — the sync job's source is an open decision (Stage 9). Do not hardcode a vendor as if decided.

### Stage 7 — Portfolios

- **Implements:** create/read/update/delete portfolios; per-plan count enforcement; derived PnL/value served from Redis.
- **Authoritative:** `System_Architecture` PORTFOLIO entity + Portfolio Module; `Schema` Portfolio/PortfolioType.
- **Module:** `portfolios/` (owns Portfolio).
- **Endpoints:** `POST /portfolios`, `GET /portfolios`, `GET /portfolios/{id}`, `PATCH /portfolios/{id}`, `DELETE /portfolios/{id}`.
- **Flow:** connected → `{ type:'connected', name, walletAddress, chainId }`, validate wallet address against chain format, then Moralis pulls assets/transactions/NFTs and the portfolio begins syncing. Manual → `{ type:'manual', name }` then assets/transactions logged separately.
- **Frontend contract:**
  - Create payloads: `NewPortfolioModal.svelte:280` → `POST /portfolios { type:'connected', name, address, chainId }`; `:338` → `{ type:'manual', name, assets }`.
  - `GET /portfolios` returns the indexed listing fields `name, type, totalValue, pnlAllTime, pnl24h, createdAt` (`System_Architecture` Presentation Layer) plus the full PnL set in the resource rep (`pnl7d/30d` + values). **This single call serves both the portfolio list and the dashboard aggregate totals** — the frontend dashboard load calls `GET /portfolios` once and derives both from it (`dashboard/+page.ts:35,41`, batched with `Promise.all`). Do **not** add a separate `/portfolios/summary` aggregate endpoint and force a second round trip; the listing already carries the derived totals.
  - Dashboard empty-state is derived from `GET /portfolios` returning `[]` (`dashboard/+page.svelte:500`), **not** from onboarding status.
  - Slugs in routes resolve server-side to an owned ID (`wallet/[portfolioSlug]/...`); the ID + ownership check are authoritative, never the slug.
- **Divergence Watch:**
  - **PnL/`totalValue`/`pnl*` are never stored on the portfolio row** — derived from snapshots, cached in Redis (5-min TTL), computed on cache miss. Adding columns for them is a divergence.
  - `type` value is `connected` (not `wallet`).
  - Count limit (1 free / 10 pro) enforced **on create**, server-side, returning `PLAN_LIMIT_REACHED`.
  - Connected portfolios cannot have manually edited assets/transactions.
  - `startingBalance` null for connected; `walletAddress`/`chainId` null for manual.

### Stage 8 — Assets

- **Implements:** add/update/delete assets on manual portfolios; per-portfolio asset list; price from Redis; token-count enforcement.
- **Authoritative:** `System_Architecture` ASSET entity + Asset Module; `Schema` Asset (`@@unique([portfolioId, tokenId])`).
- **Module:** `assets/` (owns Asset).
- **Endpoints (enumerated):**
  - `POST /portfolios/{portfolioId}/assets` — add asset (manual portfolios only)
  - `GET /portfolios/{portfolioId}/assets` — list assets
  - `GET /portfolios/{portfolioId}/assets/{id}` — asset detail
  - `PATCH /portfolios/{portfolioId}/assets/{id}` — update (manual only)
  - `DELETE /portfolios/{portfolioId}/assets/{id}` — delete (manual only)
- **Frontend contract:** `AddAssetModal:133` → `POST /assets`; `DeleteAssetModal:21` → `DELETE`. Asset rep includes derived `price, value, portfolioPercentage, pnlAllTime[+Value]` — none stored.
- **Divergence Watch:** wallet-connected assets are **read-only** (synced via Moralis); reject mutations with the right error. `balance` on manual portfolios is **derived from transactions** (Stage 9), not set directly — see the recalculation rule. Token-count limit enforced on asset creation.

### Stage 9 — Transactions (polymorphic) + Token Metadata Sync job

- **Implements:** log/update/delete transactions on manual portfolios; type-filtered list; detail joined to the right child table; **asset-balance recalculation** on every mutation. Plus the scheduled token-metadata sync that fills the Token table.
- **Authoritative:** `System_Architecture` TRANSACTION entity + Transaction Module + Token Module; `Schema` Transaction + Native/Erc20/Nft detail tables; `System_Implementation` Scheduled Jobs.
- **Module:** `transactions/` (owns Transaction + 3 detail tables); token sync in `tokens/` + `jobs/token-sync.job.ts`.
- **Endpoints (enumerated):**
  - `POST /portfolios/{portfolioId}/transactions` — log transaction (manual only)
  - `GET /portfolios/{portfolioId}/transactions` — list (base records); filter `?type=native|erc20|nft`; sort `?sort=timestamp&order=asc`
  - `GET /portfolios/{portfolioId}/transactions/{id}` — full detail, joined to the child table by `type`
  - `PATCH /portfolios/{portfolioId}/transactions/{id}` — update (manual only)
  - `DELETE /portfolios/{portfolioId}/transactions/{id}` — delete (manual only)
- **Frontend contract:** `AddTransactionModal:201` → `POST /transactions`. Resource rep carries `type` (storage class) **and** `direction` (`buy|sell|transfer`, the user action) **and** `status` (`completed|pending|failed`). `detail` is the type-specific child object. The frontend composes gas-label/explorer-link/truncated-address strings client-side — **do not** return those as fields.
- **Divergence Watch:**
  - **`type` (native/erc20/nft) and `direction` (buy/sell/transfer) are different axes.** `type` selects which child detail table to write; `direction` drives balance recalculation. Conflating them, or storing `direction` as the transaction `type` FK, is a divergence.
  - Balance recalculation must run on create **and** update **and** delete, and must invalidate the Redis PnL cache (`System_Architecture` Caching: invalidate on new manual transaction).
  - Detail retrieval joins the correct child table by `type`.
  - Connected-portfolio transactions are read-only (written only by the Moralis webhook, Stage 11).
  - **Token sync source is Moralis (primary); CMC/CoinRanking under evaluation** — open decision; a coverage spike on the 250+ list is design-time work.

**Pseudocode — transactional write + balance recalculation** *(shape, not gospel — the schema/architecture wins on specifics)*:

```
POST /portfolios/{pid}/transactions:
  assertOwnedManualPortfolio(pid, currentUser)        # 403 if connected or not owned
  body = zodValidate(input)                            # type, direction, amounts, etc.
  in a DB transaction:
    tx = insert Transaction(base fields, typeId = lookup(body.type))
    switch body.type:
      native: insert NativeTransactionDetail(tx.id, amount, symbol)
      erc20:  insert Erc20TransactionDetail(tx.id, amount, symbol, contract, name, sym)
      nft:    insert NftTransactionDetail(tx.id, contract, nftName?, nftTokenId, collection?)
    recalcAssetBalance(pid, affectedToken)             # from full tx history, per direction
  after commit: invalidate Redis PnL cache for pid
  return 201 { data: serialized tx with detail }
```

### Stage 10 — Price module & WebSocket server

- **Implements:** single persistent Coinbase connection; Redis price cache + pub/sub fan-out; client WS server with the `symbol → [socketIds]` registry; manual refresh for free users; connection resilience.
- **Authoritative:** `System_Architecture` WEBSOCKET section + Real-Time Conventions + Price Module + Connection Resilience; `System_Implementation` health endpoints.
- **Module:** `price/` + `ws/{server.ts,registry.ts}` + `lib/coinbase.ts`.
- **Endpoints/contracts:** `WSS /ws?token=<ticket>`; `POST /prices/refresh` (free only); `GET /ws/health`; the five message types in §2.7.
- **Frontend contract:** `lib/ws.ts` is the consumer — match §2.7 byte-for-byte. Client sends `subscribe` on open and re-sends on reconnect; expects `price_update.payload.{symbol,price,change24h}` + sibling `timestamp`.
- **Divergence Watch:**
  - Payload depth (see §2.7) — fields inside `payload`, `timestamp` as sibling.
  - WS authorized by the **ticket**, validated and consumed at handshake; `4001` on bad ticket, `4003` (after `plan_downgraded`) on mid-session expiry.
  - Free users **rejected at handshake (403)** — they never connect; they poll `POST /prices/refresh` (which is rate-limited and returns `403` for Pro).
  - Prices come from **Redis only**, never the DB. The WS server publishes from Redis; it does not query the DB per update.
  - Registry lives in Redis (shared state) so the backend stays horizontally scalable.
  - **Coinbase subscriptions are deduplicated and reference-counted, not per-client.** Many clients watching the same symbol (BTC, ETH) must result in **one** Coinbase subscription for that symbol, not one per client. Subscribe to Coinbase the first time a symbol gains a subscriber; **unsubscribe from Coinbase when the last subscriber for that symbol disconnects** (the `subs:<symbol>` set becomes empty). Omitting the unsubscribe leaves the upstream subscription set growing unboundedly — a slow resource leak that a naive `SADD`-only implementation will silently introduce.

**Pseudocode — handshake auth + registry + fan-out** *(shape, not gospel — the schema/architecture wins on specifics)*:

```
on WS upgrade (?token=ticket):
  payload = consumeTicket(ticket)                 # single-use; invalid/expired -> close 4001
  if user.plan != 'pro': close 403                # free users never connect
  socketId = register(connection)

on client message {type:'subscribe', payload:{symbols}}:
  for s in symbols:
    isNew = (redis.SCARD("subs:"+s) == 0)         # first subscriber for this symbol?
    redis.SADD("subs:"+s, socketId)
    if isNew: coinbaseSubscribe(s)                 # subscribe upstream ONCE per symbol

on redis pubsub "price:"+symbol -> {price, change24h}:
  for socketId in redis.SMEMBERS("subs:"+symbol):
    send(socketId, {type:'price_update', payload:{symbol,price,change24h}, timestamp})

on subscription-expired(user):                    # detected server-side
  send(user.sockets, {type:'plan_downgraded', payload:{message}, timestamp}); close 4003

on disconnect(socketId):
  for s in subscribedSymbols(socketId):
    redis.SREM("subs:"+s, socketId)
    if redis.SCARD("subs:"+s) == 0: coinbaseUnsubscribe(s)   # last watcher gone -> drop upstream
```

### Stage 11 — Moralis webhook (connected-portfolio sync)

- **Implements:** verified, idempotent sync of transactions / asset balances / NFT holdings for connected portfolios.
- **Authoritative:** `System_Architecture` MORALIS WEBHOOK + Moralis Webhook Module; Webhook Conventions/Idempotency.
- **Module:** `webhooks/` (Moralis receiver), writing **through** `transactions/` and `nfts/` (owns no tables).
- **Endpoints:** `POST /webhooks/moralis` (server-only).
- **Divergence Watch:** verify `x-signature` every time → `401` if bad. Idempotent by event ID — duplicate wallet events must not duplicate transactions. Writes go through the Transaction and NFT module services, not direct DB. Connected-portfolio data is the wallet's truth; never user-editable.

### Stage 12 — NFTs

- **Implements:** read NFT holdings per connected portfolio (Pro only); sync from Moralis on webhook.
- **Authoritative:** `System_Architecture` NFT entity + NFT Module; `Schema` Nft (`@@unique([portfolioId, contractAddress, tokenId])`).
- **Module:** `nfts/` (owns Nft).
- **Endpoints:** `GET /portfolios/{portfolioId}/nfts`, `GET /portfolios/{portfolioId}/nfts/{id}`.
- **Frontend contract:** wallet NFT tab (`/wallet?tab=nfts`), shown only for connected portfolios, Pro-gated. Resource rep includes the **nullable** marketplace metadata (`tokenStandard, floorPrice, floorPriceUsd, lastSale, lastSaleNote, rarity, traits`) enriched from Moralis where available; the frontend renders them conditionally.
- **Divergence Watch:** NFT data is read-only, never manually created. Pro-gated and connected-only — `403` for free users or manual portfolios. Marketplace fields may be null; do not assume Moralis returns them.

### Stage 13 — Snapshots (daily job)

- **Implements:** daily balance snapshot per Pro portfolio into the TimescaleDB hypertable; PnL cache invalidation; idempotency; missed-snapshot flagging.
- **Authoritative:** `System_Architecture` BALANCE SNAPSHOT + Snapshot Module; `System_Implementation` Scheduled Jobs; `Schema` BalanceSnapshot.
- **Module:** `snapshots/` (owns BalanceSnapshot) + `jobs/snapshot.job.ts`.
- **Endpoints:** `GET /portfolios/{portfolioId}/snapshots` (read; job writes, never the client).
- **Divergence Watch:** idempotent via `@@unique([portfolioId, snapshotDate])` — running twice a day must not duplicate. **Pro portfolios only** (free portfolios are not snapshotted). Each write invalidates that portfolio's Redis PnL cache. Missed snapshots flagged + logged.

### Stage 14 — Analytics

- **Implements:** summary / performance / holdings, derived from snapshots + assets, cached 5 min.
- **Authoritative:** `System_Architecture` ANALYTICS entity + Analytics Module.
- **Module:** `analytics/` (owns nothing; reads BalanceSnapshot + Asset).
- **Endpoints (enumerated):** `GET /analytics/{portfolioId}/summary`, `GET /analytics/{portfolioId}/performance`, `GET /analytics/{portfolioId}/holdings`.
- **Frontend contract:** dashboard PnL chart uses `…/summary`; `/performance` page uses all three (`System_Implementation` page defs). Response shapes are in the doc's three analytics reps — match keys exactly (`allTimePnlPct`, `allTimePnlValue`, `totalDeposits`, `totalWithdrawals`, `pnl7d[Value]`, `pnl30d[Value]`; performance `snapshots:[{date,value}]`; holdings `assets:[{symbol,value,portfolioPercentage}]`).
- **Divergence Watch:** never stored; always derived at query time, cached in Redis 5-min, invalidated on snapshot write. Pro-only server-side. Reads cross-module data **via services**, not direct table joins.

### Stage 15 — Email

- **Implements:** all transactional emails, async, logged, retried.
- **Authoritative:** `System_Architecture` Email Module + Email Reliability; `System_Implementation` Resend integration.
- **Module:** `email/` (owns nothing; triggered by other modules).
- **Triggers:** welcome + verification (Stage 1), subscription confirmation + payment receipt + cancellation + refund (Stages 3–4).
- **Divergence Watch:** must never block the request-response cycle; independent try/catch + delivery logging + retry. Use `RESEND_API_KEY`/`EMAIL_FROM_ADDRESS` (provider is Resend or equivalent). Verification-link click hits the backend directly and is what triggers the `pending_verification → verified` transition — not a client action.

---

## Part 4 — End-to-end usage flows

Each flow traces a feature across modules, naming every state change, so the seams between stages are visible. Anchored to `System_Architecture` Usage Flow and `System_Implementation` page definitions.

### 4.1 Onboarding (email, Pro)

1. `/register` → `POST /auth/register` → **User created**, `authProvider=email`, `onboardingStatus=pending_verification`. Welcome + verification email queued async (Email module).
2. User clicks verification link → hits backend directly → **`pending_verification → verified`** (server event, not a page load).
3. Wizard step 1 (path select) → **no status change** (UI-only).
4. Step 2 plan = Pro → `POST /subscriptions` → returns **Stripe checkout URL**; status still `verified`. No Pro entitlement yet.
5. Stripe charges → `POST /webhooks/stripe` (verified, idempotent) → **Payment=succeeded**, **Subscription→active**, **`verified → plan_selected → complete`** in the webhook handler. Receipt + confirmation emails async.
6. Frontend `hooks.server.ts` now reads `onboardingStatus=complete` from `GET /users/me` → dashboard access granted.
7. Step 3 (first portfolio) is optional and **does not gate `complete`**.

### 4.2 Onboarding (Google, Free)

1. `POST /auth/google` → Google token validated server-side → **User created**, `authProvider=google`, **`onboardingStatus=verified`** immediately, no password.
2. Plan = Free → `POST /subscriptions` (free) → **Free activates synchronously in the same request**, **`verified → plan_selected → complete`** server-side. No Stripe.
3. Dashboard access granted.

### 4.3 Manual portfolio + transaction → balance + PnL

1. `POST /portfolios { type:'manual', name }` (count limit checked) → **Portfolio created**.
2. `POST /portfolios/{id}/assets` (token-count limit checked) → **Asset row** at balance 0.
3. `POST /portfolios/{id}/transactions { type, direction, … }` → in one DB tx: **Transaction + child detail inserted**, **asset balance recalculated** from history per `direction`.
4. After commit: **Redis PnL cache invalidated** for the portfolio.
5. Next dashboard/analytics read recomputes PnL from snapshots+assets and **re-caches** (5-min TTL).

### 4.4 Connected portfolio → Moralis sync

1. `POST /portfolios { type:'connected', name, walletAddress, chainId }` → wallet address **validated against chain format** → **Portfolio created**, begins syncing.
2. Moralis pulls assets/transactions/NFTs (async; large syncs are non-blocking).
3. Ongoing wallet events → `POST /webhooks/moralis` (verified, idempotent) → writes **through** Transaction + NFT services → **Transactions / NFTs / asset balances updated**. All read-only to the user.

### 4.5 Real-time price (Pro)

1. Dashboard load (Pro) → `GET /auth/ws-token` → **single-use ticket**.
2. Client opens `WSS /ws?token=<ticket>` → **ticket consumed**, plan checked, **socketId registered** in Redis against each portfolio symbol.
3. Coinbase → Neonfi WS server → **price written to Redis** → **published via pub/sub** → fanned out as `price_update` only to subscribed sockets.
4. Client recalculates asset values / portfolio totals / PnL **client-side**, no server round trip.
5. Subscription expires mid-session → server sends **`plan_downgraded`**, closes **`4003`**.

### 4.6 Free price refresh

1. Free user has **no** WS connection (rejected `403` at handshake).
2. Refresh button → `POST /prices/refresh` (rate-limited; `403` for Pro) → **latest prices from Redis** (refreshed from source on 60s TTL miss).

### 4.7 Cancellation / downgrade

1. `POST /subscriptions/cancel` → **Subscription→cancelled**, remains active until period end. Cancellation email async.
2. At period end → **portfolios beyond free limit become inaccessible (not deleted)** — enforced at the application layer.
3. `POST /subscriptions/downgrade` (pro→free / yearly→monthly) → **scheduled for period end**, not immediate.

### 4.8 Daily snapshot → analytics

1. Snapshot job (configured time) → for each **Pro** portfolio, **one BalanceSnapshot** written to the hypertable (idempotent per day).
2. Each write → **Redis PnL cache invalidated** for that portfolio.
3. Analytics endpoints derive summary/performance/holdings from snapshots+assets, **cache 5-min**.

---

## Part 5 — Consolidated divergence guardrails (pre-merge checklist)

Every item below is already assumed by the schema, the docs, **and** the frontend. Tick each before merging. These are the decisions most likely to get silently "improved."

**Identity & types**
- [ ] All IDs are `Int` autoincrement — no UUIDs anywhere.
- [ ] Money (`Payment.amount`) is integer minor units; crypto quantities are `Decimal(20,8)`; market cap `Decimal(30,2)`. No floats.

**Enums as lookup tables**
- [ ] No Prisma native `enum`s — all eight enum tables are seeded `id+name` rows joined by FK.
- [ ] Seeded `name` strings match the frontend exactly: `connected`/`manual`, `native`/`erc20`/`nft`, `active`/`cancelled`/`expired`, `pending`/`succeeded`/`failed`/`refunded`, `pending_verification`/`verified`/`plan_selected`/`complete`, `email`/`google`, `free`/`pro`, `monthly`/`yearly`.

**Auth & session**
- [ ] REST auth via HttpOnly cookie named `session`; no Authorization header.
- [ ] WS auth via single-use ticket from `GET /auth/ws-token` returning `{ data:{ token, expiresIn } }`; consumed at handshake; `4001` on bad ticket.
- [ ] `GET /users/me` returns `displayName` (frontend reads `name ?? displayName`) and `authProvider` as a string; no invented `name` column.
- [ ] Onboarding transitions are server-event-driven (verify-link, plan confirmation, Stripe webhook) — never client navigation; `complete` does not require first-portfolio creation.

**Plan enforcement (server-side only)**
- [ ] Portfolio count (1/10) on `POST /portfolios`; token count (10/250+) on asset creation + `GET /tokens`; chain count (3/15) on `GET /chains`.
- [ ] NFT, analytics, snapshots, real-time WS = Pro-only, verified per request; free users `403`; `POST /prices/refresh` is free-only.
- [ ] No reliance on any frontend/`mockPro` gating for enforcement.

**Derived values never stored**
- [ ] Portfolio PnL/`totalValue`/`pnl*`, asset `value`/`portfolioPercentage`/`pnl*`, all analytics — computed at query time, cached in Redis, never columns.

**Contracts & shapes**
- [ ] Success `{data,meta}` / error `{error:{code,message}}`; `PLAN_LIMIT_REACHED` on plan limits; `400` on invalid filters; no stack traces.
- [ ] Offset pagination everywhere except the **token list** (cursor `{limit,nextCursor}`).
- [ ] WS `price_update` fields nested in `payload`, `timestamp` sibling of `type`; subscribe/reconnect/plan_downgraded/error shapes per §2.7.
- [ ] Transaction `type` (native/erc20/nft → child table) and `direction` (buy/sell/transfer → balance recalc) kept as separate axes.

**Idempotency & async**
- [ ] Stripe webhook, Moralis webhook, snapshot job all idempotent (event ID / `@@unique` snapshot).
- [ ] Plan transitions for Pro only after verified Stripe webhook — never on client assertion.
- [ ] Email, token sync, snapshot, Moralis sync, Stripe state updates run outside the request cycle.

**Read-only boundaries**
- [ ] Connected-portfolio assets/transactions/NFTs are read-only (Moralis-written); mutation endpoints reject them.
- [ ] Snapshots/tokens/chains written only by jobs/sync/seed, never by client endpoints.

**Module isolation**
- [ ] No cross-module direct DB queries; inter-module calls via services; webhook modules write through Transaction/NFT/Subscription services.

---

## Part 6 — Non-functional & cross-cutting concerns

These requirements belong to no single feature stage and are exactly what a stage-organized guide tends to drop. Every item is anchored to its source; where the docs leave a specific open, it is flagged as design-time work rather than invented.

### 6.1 Consistency model

`System_Architecture` Consistency Model; `System_Implementation` Database Characteristics.

- **Strong consistency (CP):** subscriptions, payments, portfolios, transactions. These are the transactional core and use PostgreSQL with enforced constraints.
- **Eventual consistency (acceptable):** live price data, served from Redis. A 1–2s stale price is explicitly *not* a correctness problem. Never block a request waiting for a fresher price.
- **Append-only / consistent by nature:** balance snapshots and PnL history (time-series).
- **Cross-cutting implication:** the price path (Coinbase → Redis → pub/sub → client) deliberately **bypasses the database** (`System_Architecture` Data Layer). Do not "fix" eventual price consistency by reading prices from the DB — that contradicts the model.

### 6.2 Performance targets

`System_Architecture` Performance / Response Targets.

- Real-time price update → connected Pro client: **< 1s** from Coinbase receipt.
- Dashboard initial load: **< 500ms** under normal load.
- Token search results: **< 300ms**.
- REST portfolio/asset responses: **< 200ms** under normal load.
- The daily snapshot job **must not impact user-facing response times** — runs as a background job.
- These are targets to design toward and measure, not enforced gates; no doc specifies how they're measured (design-time: pick the monitoring approach in 6.8).

### 6.3 Caching strategy & invalidation triggers

`System_Architecture` Caching Conventions + Performance/Caching Strategy. (Restated from §2.5 as a cross-cutting concern because invalidation spans modules.)

- **Token prices:** Redis, TTL **60s**; miss → fetch fresh from source; never from DB.
- **PnL / portfolio value:** Redis, TTL **5min**; **invalidated on (a) new snapshot write or (b) new manual transaction.** Both triggers cross module boundaries (Snapshot module, Transaction module) — wire both.
- **Token metadata:** Redis, TTL **24h**; invalidated on sync-job completion.
- **Cache-miss policy:** fall back to DB query, write result back to cache.
- **No CDN for authenticated data** — all portfolio responses are private, served directly from the backend.

### 6.4 Realtime layer (WebSocket + Redis pub/sub) — cross-cutting contracts

`System_Architecture` WebSocket section, Real-Time Conventions, Connection Resilience, Price Module; consumer side in `lib/ws.ts`. The full message envelopes are in **§2.7** — not duplicated here; this subsection covers the *guarantees and channel contracts* that aren't owned by Stage 10 alone.

- **Delivery guarantee:** best-effort fan-out, not guaranteed delivery. During a Coinbase reconnection, **Redis retains the last known price per token** so clients are never served stale nulls. There is no replay/ack protocol — a client that misses a frame simply gets the next one.
- **Pub/sub channel contract:** price fan-out uses Redis pub/sub keyed per symbol; the subscription registry is a Redis map **`symbol → [socketIds]`** (`System_Architecture` WebSocket note + Price Module). The exact Redis key naming (e.g. `subs:<symbol>`, channel `price:<symbol>`) is **not specified in the docs — design-time work;** keep it internal to `ws/registry.ts` and `price/`.
- **Server→Coinbase resilience:** one shared persistent connection; health ping every **30s**; dead if no pong within **5s**; reconnect with exponential backoff **1s→2s→4s→8s→16s, cap 30s**; alert engineering after **5 failed attempts**; notify clients via `reconnect` message.
- **Client resilience (already in `lib/ws.ts`):** exponential backoff cap 30s; re-send `subscribe` on reconnect; fetch a fresh WS ticket if expired; surface connection-lost/restored indicator.
- **Process health:** `GET /ws/health` returns 200 only when both the client-facing WS server and the Coinbase connection are up, else 503 (triggers a Coolify container health-check restart). On restart, **all socket IDs are cleared from Redis** and clients reconnect fresh. (Health-check note: the backend container must include `curl` or `wget` for Coolify's in-container health check to work — a minimal Node image ships with neither.)
- **Close codes:** `4001` invalid/expired/consumed ticket; `4003` Pro expiry mid-session (after `plan_downgraded`).

### 6.5 Time-series (TimescaleDB) policies

`Schema` BalanceSnapshot note; `System_Architecture` Database Optimization; `System_Implementation` ORM section.

- **Hypertable:** `balance_snapshot` partitioned on `snapshot_date`; created by a **raw-SQL migration after `prisma migrate deploy`** (Prisma does not manage hypertables). The deploy step runs the conversion if not already applied. Requires `CREATE EXTENSION IF NOT EXISTS timescaledb;` once on the Neon database.
- **Compression: NOT used.** The docs' original "compression older than 7 days" is **dropped** — Neon's managed TimescaleDB supports only Apache-2 features and compression is not among them. At demo scale snapshot volume is small and uncompressed storage is a non-issue.
- **Retention:** handled by a **scheduled `drop_chunks` job** (drop chunks older than the chosen window) rather than compression. The drop-after duration is still **design-time — pick a window** (e.g. keep N months of snapshots) before relying on it; the mechanism is `drop_chunks`, the number is yours to set.
- **Access restriction:** hypertable access is **restricted to the Snapshot Module** (`System_Architecture` Database Security) — no other module queries it directly.
- **Continuous aggregates: unavailable on Neon.** If analytics performance ever needs pre-rolled daily/weekly PnL, that is a deliberate design decision requiring a different Postgres host (self-hosted Timescale community edition) — it is not a Neon toggle, and it is not in scope today.

### 6.6 Pagination (cross-cutting)

`System_Architecture` Pagination Standards. (Cross-cutting because it spans every list endpoint; restated from §2.4 for completeness.)

- **Offset** everywhere (`?limit&offset`, `meta:{limit,offset,total}`) **except** the **token list**, which is the only **cursor-based** endpoint (`?cursor=<last_token_id>&limit`, `meta:{limit,nextCursor}`) for infinite scroll. Using the wrong scheme on either side is a divergence.

### 6.7 Availability, backup & recovery

`System_Architecture` Availability / Backup Strategy / Recovery Objective.

- **Availability target:** 99.5% (MVP), designed to evolve to 99.9%.
- **Backups:** Postgres is **Neon (managed)** — Neon provides automated backups and point-in-time restore as a platform feature, which satisfies the daily-backup + PITR requirement without you running backup jobs. **Retention-window duration is still design-time — set it** (the doc says "Retention policy" without a number; Neon's history-retention setting is where you configure it). Restore testing is still your responsibility. Redis is self-hosted and **cache-only** (no durable state worth backing up — it can be rebuilt from Postgres + live feed on restart).
- **RPO:** 0–1 hour, via PITR or transaction-log shipping supplementing daily backups.
- **RTO:** 4–8 hours, via redeploying the backend container in Coolify + restoring/attaching the Neon database (Neon restore is a managed operation; the backend is a stateless container redeployed from the image) (justified as fitting the 99.5% budget).
- **Production must use non-sleeping instances** — especially the WS server, which must hold the persistent Coinbase connection (`System_Implementation` Environment Separation).

### 6.8 Observability & logging

`System_Architecture` Observability + Audit & Logging; `System_Implementation` Observability.

- **Structured application logging**, emitted to the container's stdout (collected by Coolify; ship onward to a hosted log aggregator for retention/querying — see §6.8.1); basic uptime monitoring; `LOG_LEVEL` env-driven.
- **Monitored:** WebSocket connection count; Redis memory usage + cache-miss rate; Coinbase connection health (separately from general uptime); DB performance.
- **Logged with outcome:** login attempts/failures; Google OAuth events; subscription upgrades/downgrades/cancellations; Stripe + Moralis webhook receipt & processing; portfolio creation/deletion; WS connect/disconnect; Coinbase failures/reconnects; snapshot job success/failure; token-sync job success/failure; email delivery attempts/outcomes.
- **Logs must NOT expose:** internal topology, DB schema details, production stack traces, business-rule logic, or plaintext wallet addresses beyond debugging need. Logs are treated as untrusted, sanitized, structured.
- **Health endpoints:** `GET /health` (200 only when DB + Redis + Coinbase all up) and `GET /ws/health` (per 6.4); external monitor pings every 1 min, alerts on two consecutive failures (`System_Implementation` Service Resilience).

#### 6.8.1 Implementation guidance — resource & usage monitoring

> This subsection is **implementation guidance only**. The monitoring/observability *requirements* are owned by `System_Architecture` Observability + Audit & Logging and `System_Implementation` Observability/Service Resilience (summarized in 6.8 above). Nothing here adds a new requirement; it routes the existing ones to the cheapest delivery and marks the MVP line. The goal: see usage spikes and attribute resource consumption per module, per action, and per user without over-building an observability platform. **Last-mile provider/tool APIs evolve — pin the approach below, verify the specific API/headers against current docs at build time.**

**Layer 1 — infrastructure metrics (CPU/memory/bandwidth): self-managed, minimal, configure-only.** On the original Render model this was a free per-service dashboard. On the Hostinger VPS + Coolify model, the equivalent is assembled from pieces — but it is still *configure, not build*, and stays deliberately minimal to not consume the resources it measures (do **NOT** stand up a Prometheus/Grafana stack on a small VPS — that is over-building and eats the RAM you are conserving):
> - **CPU / memory:** Coolify's built-in per-container stats cover the backend container and the Redis container at a glance.
> - **Database metrics:** **Neon is managed and ships its own metrics dashboard** (connections, compute, storage) for free — this claws back the "DB metrics for free" benefit that a self-hosted Postgres would have cost you.
> - **HTTP request volume / latency:** this is the one thing the host no longer gives free. It is covered instead by the Layer-2 tagging middleware below — which you were building anyway. On this stack the middleware is your *primary* request-metrics source, not a supplement.
> - **Uptime:** an external pinger (e.g. a free hosted uptime monitor), 1-min ping, alert on two consecutive failures — host-agnostic, same as the original plan.
>
> **Agent builds nothing here** (the `/health` + `/ws/health` endpoints are already build items in 6.8/6.4). **You configure** Coolify stats, the Neon dashboard, and the external uptime monitor. Persistent-connection caveat unchanged: realtime load shows up as steady CPU/memory on the backend container, **not** as request-rate — Layer 2 fills that gap.

**Layer 2 — application drill-down (per module/action/user): one tagging middleware + a hosted log tool.** This is the only real build, and it leans on the already-required "structured application logging" — it disciplines the field schema, it does not add a system. **Agent builds:** a single Hono logging middleware emitting one structured (JSON) line per request with a fixed schema — `module`, `action`, `userId`, `planTier`, `durationMs`, `statusCode`. `module`/`action` fall out of the existing controller/route structure for free. The same schema is emitted from jobs, webhooks, and the WS lifecycle (below) so every surface lands in the same queries. **You configure:** a hosted log aggregator (the backend logs to container stdout, collected by Coolify and shipped onward; free tiers are sufficient at MVP) with dashboards/queries like p95-latency-by-module, requests-by-user, error-rate-by-action.
  - **MVP line:** structured logs give per-user *request volume and latency* — the right MVP target. True per-user *CPU/memory* attribution needs distributed tracing/profiling (OpenTelemetry + tracing backend) — **deferred, not MVP; flag as over-building until scale forces it.**

**Layer 3 — dashboards & alerting: configuration, not code.** Coolify (container resource thresholds) and Neon (DB thresholds) handle infra alerts; the log aggregator handles application dashboards + log-based alerts; the uptime monitor handles availability alerts. The doc-mandated alerts (5 failed Coinbase reconnects → engineering; missed snapshot; two consecutive health-check failures) are already required as logged events — **agent ensures each is emitted as a structured, alertable line**; **you configure** the alert rule + routing. Building a bespoke alerting pipeline is over-building.

**Neonfi-specific instrumentation points** (all reuse the Layer-2 schema; all anchor to existing build items):
  - **WebSocket / realtime** — instrument the `on connect` / `on disconnect` / `on message` hooks already in the Stage 10 pseudocode: connect/disconnect emit a tagged line (`userId`, `planTier`) → gives churn (connect/disconnect rate) and active-connection gauge (already required: "WebSocket connection count monitored"); message send emits `type`/`action` → gives throughput. RPS does not capture this model; these hooks do. Per-connection resource cost stays aggregate (WS-service CPU ÷ active connections) at MVP; per-connection profiling is over-building.
  - **Redis pub/sub** — subscriber counts already live in the data: `SCARD subs:<symbol>` is the fan-out per channel. A low-frequency recurring task logging `SCARD` for active channels + Redis `INFO` (memory, ops/sec, channel count, already required: "Redis memory usage monitored") covers bottleneck/cost visibility. Self-hosted Redis exposes all of this via `redis-cli INFO` (and Coolify shows the container's memory) — there is no managed Redis dashboard, so the `INFO` gauge task is how you get these numbers. Don't build a Redis analytics layer.
  - **TimescaleDB / time-series** — the surface a normal setup misses. Ingestion rate ≈ snapshot-job write count (already logged). A **daily scheduled query** logging hypertable size + chunk count (from Timescale's informational views) gives growth trends cheaply. Continuous-aggregate refresh cost and retention behavior are **only relevant once those features are adopted** — and they are currently flagged design-time in the Appendix — so monitoring them is **deferred until the feature exists.**
  - **Web3 / external providers (the real cost/rate-limit surface)** — highest cost-visibility value. Wrap each external client (Moralis, Coinbase, Stripe, Logokit, Resend) in a thin layer that counts calls, logs latency, and records returned rate-limit headroom, tagged by `provider` + `action`. Gives call volume per provider, quota headroom, and — with each provider's pricing — the actual cost driver, which is where spikes and overruns hide. **Verify each provider's rate-limit header/quota API against current provider docs at build time** (these change).

**In-app monitoring page — do NOT build (developer observability).** A developer-facing in-app monitoring page duplicates Coolify + Neon + the log tool, consumes the resources it measures, shares the app's fate (unavailable during the incident you need it for), and risks exposing internal topology — which the Audit & Logging rules explicitly forbid. **Developer observability must live outside the app, in external tooling.** Distinct concern: *business/usage analytics an end-user or admin sees in-app* is a product-analytics feature, not resource monitoring — out of scope here, and note the admin surface is already Appendix-flagged as undefined at API/schema level. No admin monitoring dashboard at MVP.

**MVP summary:** *build* — Layer-2 tagging middleware + same schema on WS/jobs/webhooks, per-provider call wrappers, `SCARD` + Timescale-size gauge tasks + Redis `INFO` gauge (all small, all reuse one schema). *Configure* — Coolify container stats, Neon DB dashboard, external uptime monitor, hosted log aggregator + dashboards + alert rules. *Defer* — distributed tracing / per-user CPU attribution, continuous-aggregate/retention monitoring (continuous aggregates unavailable on Neon anyway). *Avoid* — Prometheus/Grafana stack on the VPS, in-app developer monitoring page, bespoke alerting infra, per-connection/request profiling.


### 6.9 Rate limiting & abuse protection

`System_Architecture` API Security → Rate Limiting.

- Rate-limit: login/auth endpoints; `POST /prices/refresh` (free users cannot spam manual refresh); `POST /portfolios` (prevents rapid creation).
- Bruteforce protection + **account lockout after repeated failed logins**, with **configurable lockout duration** (the duration value itself is left configurable — set it at deploy time, not in code constants).

### 6.10 System-wide security hardening

`System_Architecture` Security Requirements, Authorization Architecture, Data Protection, API Security, OWASP section; `System_Implementation` Security Considerations.

- **Transport:** all HTTP over HTTPS (TLS 1.2+); all WS over WSS (TLS 1.2+).
- **Passwords:** bcrypt or Argon2; no plaintext; strong-password policy; Google users have no password field.
- **Authorization:** RBAC + plan guards **enforced server-side**, before controller logic, on every protected route; resource-ownership checks everywhere; **frontend checks never authoritative**.
- **Input validation:** strict server-side Zod on every endpoint; reject malformed/unexpected payloads; wallet addresses validated against selected chain format before acceptance.
- **Sensitive data:** Stripe customer/subscription IDs stored but never logged; wallet addresses stored plaintext (public on-chain data by nature); webhook secrets environment-specific and never logged.
- **Data at rest:** DB in secured environment, firewalled; backups encrypted; Redis not publicly exposed (backend-only).
- **OWASP Top 10 mitigations:** injection (parameterized queries only), broken auth, broken access control, sensitive-data exposure, XSS (input sanitization), CSRF (cookie-based — relevant since auth is cookie-based; `SameSite` + CSRF protection needed), security misconfiguration.
- **DB security:** least-privilege DB user; separate app vs admin credentials; FK constraints enforced; no public DB/Redis exposure.

### 6.11 SEO / SSR / prerender — NOT specified (design-time)

**Neither the architecture nor the implementation doc mentions SEO, SSR strategy, prerendering, sitemap, `robots.txt`, meta tags, or Open Graph.** The frontend is SvelteKit with a public landing/pricing surface where SEO would plausibly matter, but **the docs are silent**, so this guide invents nothing. If SEO is in scope, decide and document: which public routes prerender vs SSR, sitemap/robots generation, and meta/OG tags. This is a frontend concern and design-time work — flagged here only so it isn't silently forgotten.

---

## Appendix — Open / design-time items (do NOT invent; resolve in the authoritative docs first)

These are genuinely underspecified or undecided in the current docs. The guide flags them; it does not fill them.

1. **Chain list.** The 15 supported chains and which 3 are free-tier are not enumerated anywhere. Decide and seed before Stage 5. (`System_Architecture` Chain entity says only the counts.)
2. **Token metadata vendor.** Moralis is primary; CoinMarketCap / CoinRanking are under evaluation pending a coverage spike on the 250+ list. Stage 6/9 must not hardcode a vendor as decided. (`System_Architecture`/`System_Implementation` token sections.)
3. **`/api/v1` wiring.** The version prefix must be baked into the frontend's `VITE_API_URL`; confirm during integration (frontend calls bare paths).
4. **`name` vs `displayName`/`fullName`.** Decide whether `/users/me` returns `displayName` (frontend already falls back) or the frontend changes to read `displayName` directly. Do not add a `name` column.
5. **Admin surface.** `System_Architecture` lists Admin functional requirements (view all users/subscriptions, usage analytics) but there are **no admin endpoints, module, or role field** in the schema/API. Admin is specified at requirements level only — full design-time work before any admin build. Out of scope for the stages above.
6. **`emailVerified` exposure.** Present in the User resource rep; confirm the backend sets/returns it and that the onboarding wizard's verification gating reads it as intended.
7. **Redis pub/sub key naming.** The registry is specified as `symbol → [socketIds]` but the concrete Redis key/channel names are undefined. Keep internal to `ws/registry.ts` + `price/`. (Part 6.4.)
8. **TimescaleDB retention window.** Compression is **dropped** (unavailable on Neon — see Part 6.5), so the only open item here is the **retention/drop-after duration** for the `drop_chunks` job — decide how long snapshots are kept. Continuous aggregates are likewise unavailable on Neon; not in scope. (Part 6.5.)
9. **Backup/history retention duration.** Neon provides managed backups + PITR; the **history-retention window** is a Neon setting you must choose (the doc says "Retention policy" without a number). (Part 6.7.)
10. **Account-lockout duration.** Lockout is required and explicitly configurable; the value is a deploy-time setting, not a code constant. (Part 6.9.)
11. **SEO / SSR / prerender / sitemap / robots.** Entirely unmentioned in both docs. If in scope, a frontend design-time decision. (Part 6.11.)
12. **Performance-target measurement.** The <1s / <500ms / <300ms / <200ms targets are stated but the measurement/monitoring method is not. (Part 6.2 / 6.8.)

---

*End of guide. This document is derived from and subordinate to `Neonfi_Database_Schema`, `Neonfi_System_Architecture`, `Neonfi_System_Implementation`, and the frontend codebase. If it conflicts with any of them, those win — flag the conflict.*
