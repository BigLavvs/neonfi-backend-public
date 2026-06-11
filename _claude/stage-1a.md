# Neonfi backend — Stage 1A: Auth primitives + email auth flows

This file is the source-of-truth intent for Stage 1A. Build from this; report back to Idowu when done. Stage 1B (Google OAuth + session list/revoke + WS ticket) lives in a separate prompt and is **NOT** part of this work.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `9b1a68d` (Part 1 fully closed; hypertable live; .env populated).

## 0. Read first

In this order, the entire file each time:

1. `Neonfi_Backend_Build_Guide.md` (in the frontend repo at `C:\Users\pelum\Desktop\Neonfi\docs\`) — **§0 in full** (especially §0.4 locked decisions and §0.3 mock-seam inventory); **§2 in full** (cross-cutting contracts — envelopes, auth model, idempotency, async); **Stage 1** in §3.
2. `src/modules/users/users.contract.ts` (in this repo) — Gate C (`displayName` not `name`) and Gate D (`emailVerified` derived, never a column). Both decisions are LOCKED.
3. `prisma/schema.prisma` — User, Session, AuthProvider, OnboardingStatus models. Re-verify the field names and types against what you write; the schema wins (§0.1).
4. The frontend's `src/lib/api.ts` and `src/hooks.server.ts` (in the frontend repo). The cookie name `session`, the error envelope shape `err.error.code/message`, and the `name ?? displayName` fallback live here.

When in doubt: docs win over Build Guide; frontend wins over docs on *consumed* shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions for this prompt (record in code comments)

These aren't yours to re-decide — they're the answers locked in so you build consistently. If you find one genuinely impossible, STOP and surface it.

### 1.1 Two-cookie session model

The Build Guide names `ACCESS_TOKEN_EXPIRY=15m` and `REFRESH_TOKEN_EXPIRY=7d` as separate concepts; honor that with two HttpOnly cookies:

- **`session`** — JWT access token, 15m lifetime, contains `{ userId, sessionId, iat, exp }`, signed with `JWT_SECRET`. Read on every authenticated request by the auth middleware. **This cookie name is hardcoded by the frontend** (`hooks.server.ts:30`) — do not rename, do not pluralize.
- **`refresh`** — opaque random token (32 random bytes, base64url-encoded), 7d lifetime, NOT a JWT. Backend stores the SHA-256 hash of this value in `Session.refreshTokenHash` ⚠️ but `Session` has no `refreshTokenHash` column — see §1.2 below. Used only by `POST /auth/refresh`.

Both cookies: `HttpOnly`, `SameSite=Strict`, `Secure` only when `NODE_ENV === 'production'` (the frontend dev runs on `http://localhost:5173`; Secure on http breaks the cookie). Path `/`, no Domain attribute (so each origin sets its own — `api.neonfi.live` in prod, `localhost:3000` in dev). The auth cookie set by `api.neonfi.live` will be sent on `credentials:'include'` fetches from `neonfi.live` because they're same-site (same registered domain).

### 1.2 Schema constraint: where the refresh-token hash lives

The `Session` schema has `id, userId, ipAddress, userAgent, expiresAt, revokedAt, createdAt` and NO column to hold the refresh-token hash. You have two options; pick **(a)**:

- **(a) [PICKED] Store the SHA-256 hash of the refresh token in a NEW column `refreshTokenHash String @unique @db.VarChar(64)`** on `Session`. This is a schema delta beyond the docx — surface it like the `BalanceSnapshot` PK change: add the column with an inline NOTE explaining why ("docx omits a refresh-token storage column despite requiring stateful refresh sessions; without it `POST /auth/refresh` cannot match an incoming refresh cookie to a Session row"), generate a migration `auth_session_refresh_token_hash`, and leave Idowu to mirror the addition in the schema docx separately. Per §0.1 the docx wins — but the docx is internally incomplete here; the same defect pattern as `Payment.user` and `BalanceSnapshot` PK.
- (b) Use `Session.id` + a JWT-format refresh token. Awkward because refresh tokens are then signed and exp-bearing, defeating the "refresh sessions are revocable server-side" point of the table.

If anything else about the schema feels uncompilable as you go, STOP and ask — do not invent.

### 1.3 Account-lockout duration (Appendix item 10)

Required behavior, unspecified value. Add **two new env vars** to the Zod loader and `.env.example` with sensible defaults; do not invent a code constant.

- `AUTH_LOGIN_MAX_ATTEMPTS` (int, default `5`)
- `AUTH_LOGIN_LOCKOUT_MS` (int, default `900000` = 15 minutes)

State is in Redis: key `lockout:login:<email>` with a counter and a TTL. Incremented on bad password, cleared on successful login. When counter ≥ MAX_ATTEMPTS, all login attempts for that email return `423 Locked` with code `ACCOUNT_LOCKED` until the TTL expires. Pin Idowu on the values in production — code defaults are MVP-grade.

### 1.4 Email verification link URL

The verification email contains a link to **`${APP_BASE_URL}/verify-email?token=<token>`** — the frontend, not the backend. The frontend page (not yet built; that's a frontend task) reads the token and calls `POST /auth/verify-email { token }`. Pure REST, no backend GET handler with HTML response. For dev testing: log the verification URL to stdout (LOG_LEVEL respected) so you can hit the POST endpoint manually with curl or Postman.

The Build Guide narrative says "Verification-link click hits the backend directly" — this is a frontend-passthrough; the click navigates to the frontend page which then hits the backend. The intent ("server-driven status transition, not a manual API call from the dashboard") is preserved.

### 1.5 Password policy

System_Architecture says "Strong password policy enforced" without specifics. Use these Zod-enforced rules — they're conservative MVP-grade:

- Minimum 8 characters
- At least one letter AND at least one number
- Maximum 128 characters (defends against bcrypt slowdown DoS)

Return `400` with code `WEAK_PASSWORD` on failure. Don't expose which specific rule failed in production messages.

### 1.6 Refresh-token rotation

**Non-rotating refresh** for Stage 1A. One Session per login, lives until `expiresAt` or `revokedAt` is set. Refresh issues a new access token from the same Session row; the refresh cookie itself doesn't change. Lower complexity, matches the table's natural semantics. Add a TODO comment in the refresh handler for the rotation upgrade later (post-MVP security review).

## 2. Module scope for this prompt

You build code in these directories only:

```
src/modules/auth/         # Stage 1A surface — controllers + service + Zod schemas
src/modules/users/        # User + Session repository functions (Stage 1A subset)
src/modules/email/        # Welcome + verification email senders ONLY (Stages 3, 4, 15 extend later)
src/lib/                  # auth/crypto helpers (jwt.ts, password.ts, cookies.ts, lockout.ts)
prisma/                   # one new migration for Session.refreshTokenHash (§1.2)
tests/                    # Vitest integration tests
```

Do NOT touch any other module directory. They keep their `.gitkeep`.

The `auth` module owns no tables (it orchestrates). The `users` module owns `User` and `Session`. The `email` module owns nothing (called by auth). This is the canonical layering from System_Implementation §4 — preserve it. **Route handlers are controllers only**: parse + validate input, call a service, return the envelope. No DB queries in controllers; no business logic in controllers.

## 3. Endpoints in this prompt (10 in Stage 1 total; this prompt is 6 of them)

For each endpoint: request body shape (Zod-validated), response shape, status codes, what it touches in DB/Redis, and the explicit error envelope codes. Build them in this order so you can test as you go.

### 3.1 `POST /auth/register` — email registration

**Request:**
```json
{ "email": "<email>", "password": "<password>", "fullName": "<full name>", "displayName": "<optional>" }
```
- `email` valid email, lowercased before insert.
- `password` per §1.5.
- `fullName` 1–255 chars.
- `displayName` optional, 1–100 chars.

**Flow (in a single DB transaction):**
1. Validate. Reject `400 WEAK_PASSWORD` / `400 VALIDATION_ERROR`.
2. Check email uniqueness. If exists: `409 EMAIL_ALREADY_REGISTERED`.
3. Resolve `authProvider.name = 'email'` → row id. Resolve `onboardingStatus.name = 'pending_verification'` → row id. (Both are LOOKUP-TABLE FKs per §0.4 — never store strings.)
4. Hash password with bcrypt cost 12.
5. Insert User row.
6. **Commit.**
7. **After commit (background, fire-and-forget, independent try/catch):**
   - Generate verification token: 32 random bytes, hex-encoded. Store in Redis as `email_verify:<token>` → `<userId>` with TTL 86400 (24h).
   - Send welcome email (Resend, async).
   - Send verification email with link `${APP_BASE_URL}/verify-email?token=<token>` (Resend, async).
   - On failure: log structured error; do NOT crash the response.

**Response:** `201` with `{ data: { user: { id, email, fullName, displayName, authProvider: 'email', emailVerified: false, onboardingStatus: 'pending_verification', createdAt } } }`.
- `emailVerified` is DERIVED in the service layer per Gate D: `onboardingStatus.name !== 'pending_verification'`. Centralize this derivation in `users.repository.ts` or a `toUserDTO()` helper. Never expose a stored column.
- Do NOT set a session cookie. The user must verify email before logging in. (System_Implementation page def: email-registered users land in onboarding step 0 / verify email.)
- Do NOT include `passwordHash`, `authProviderId`, `onboardingStatusId`, or `newsletterSubscribed` defaults the docx wants suppressed.

### 3.2 `POST /auth/login` — email login

**Request:** `{ "email": "<email>", "password": "<password>" }`

**Flow:**
1. Lockout check (§1.3): read `lockout:login:<email>` counter. If ≥ `AUTH_LOGIN_MAX_ATTEMPTS`, return `423 ACCOUNT_LOCKED` with `meta: { retryAfterMs }`.
2. Find user by email (lowercased). If not found: increment lockout counter, return `401 INVALID_CREDENTIALS` (do NOT distinguish "user doesn't exist" from "wrong password" in the response — uniform error prevents email enumeration).
3. Verify password (bcrypt). If wrong: same as above — `401 INVALID_CREDENTIALS`, increment lockout.
4. On success: clear `lockout:login:<email>` from Redis.
5. Create Session: insert row with `expiresAt = now + REFRESH_TOKEN_EXPIRY`, `ipAddress`, `userAgent` (read from request headers; if absent, store null). Generate refresh token (32 random bytes, base64url). Hash with SHA-256, store in `refreshTokenHash`.
6. Issue access token JWT: payload `{ sub: userId, sid: sessionId }`, expires per `ACCESS_TOKEN_EXPIRY`. Signed HS256 with `JWT_SECRET`.
7. Set both cookies (`session` = access JWT, `refresh` = the raw random token).
8. Respond: `200` with `{ data: { user: { id, email, fullName, displayName, authProvider, emailVerified, onboardingStatus, createdAt } } }` (same shape as register but with full session state ready).

### 3.3 `POST /auth/logout` — single-session revoke

**Auth required.** Reads `session` cookie via middleware.

**Flow:**
1. Find Session by sessionId from JWT.
2. Set `revokedAt = now`.
3. Clear both cookies (Set-Cookie with Max-Age=0).
4. Respond: `200 { data: { ok: true } }`.

If no cookie / invalid session: still return `200` (idempotent — logging out an already-logged-out session is not an error). Clear cookies regardless.

### 3.4 `POST /auth/verify-email` — verify email link click

**No auth.** Request: `{ "token": "<verification-token>" }`

**Flow:**
1. Look up `email_verify:<token>` in Redis. If absent: `400 INVALID_VERIFICATION_TOKEN`.
2. Get userId from Redis value.
3. Delete the Redis key (single-use, atomic — use `GETDEL` or pipeline GET + DEL).
4. Load User. If User's onboardingStatus is already `verified` / `plan_selected` / `complete`: respond `200 { data: { alreadyVerified: true } }` — idempotent.
5. Else: resolve `onboardingStatus.name = 'verified'` → row id. Update User's `onboardingStatusId`. Commit.
6. Respond: `200 { data: { user: { id, email, fullName, displayName, authProvider, emailVerified: true, onboardingStatus: 'verified', createdAt } } }`.

This transitions `pending_verification → verified` per §Stage 1 flow. The next transitions (`verified → plan_selected → complete`) belong to Stage 3 (subscriptions) — do NOT implement them here. Never trigger them from any auth endpoint.

### 3.5 `POST /auth/resend-verification` — re-send verification email

**Auth NOT required** (the user can't log in yet because they're unverified). Request: `{ "email": "<email>" }`.

**Flow:**
1. Rate-limit by email in Redis: `resend_verify:<email>` set with TTL 60s on each call. If key exists when called: `429 TOO_MANY_REQUESTS`.
2. Find user. If absent OR already verified: respond `200 { data: { ok: true } }` anyway (uniform response to prevent email enumeration / probing).
3. If pending_verification: generate new verification token, overwrite `email_verify:<token>` in Redis with TTL 86400, send verification email async.
4. Always respond `200 { data: { ok: true } }`.

### 3.6 `POST /auth/refresh` — issue new access token

**No `session` cookie required** (it's expired — that's the point). Reads `refresh` cookie.

**Flow:**
1. Read `refresh` cookie. If absent: `401 NO_REFRESH_TOKEN`.
2. SHA-256-hash the refresh value.
3. Find Session by `refreshTokenHash`. If not found: `401 INVALID_REFRESH_TOKEN`.
4. If `revokedAt` is set or `expiresAt < now`: `401 SESSION_EXPIRED`.
5. Load User. Issue new access token JWT (same shape as login). Set `session` cookie. Leave `refresh` cookie untouched (no rotation — §1.6).
6. Respond: `200 { data: { ok: true } }`. The new cookie is the carrier; no need to echo user info (frontend will call `GET /users/me` separately in Stage 2 if it needs the user state).

## 4. Cross-cutting wiring

### 4.1 Auth middleware (`src/modules/auth/middleware.ts`)

Hono middleware. On every protected route:

1. Read `session` cookie. If absent: `401 UNAUTHENTICATED`.
2. Verify JWT signature + exp with `JWT_SECRET`. If invalid: `401 UNAUTHENTICATED`. If expired: `401 ACCESS_TOKEN_EXPIRED` (the frontend uses this code to know it should call `/auth/refresh`).
3. Load Session by `sid`. If `revokedAt` set or `expiresAt < now`: `401 SESSION_EXPIRED`.
4. Load User. Attach to context: `c.set('user', user); c.set('session', session)`.
5. Call `next()`.

This middleware is used by `POST /auth/logout` in this prompt and by every authenticated endpoint in later stages. Stage 1B's `GET /auth/sessions` + `DELETE /auth/sessions/{id}` + `GET /auth/ws-token` will reuse it. Build it once, reuse everywhere.

### 4.2 Plan-based access control middleware (`src/modules/auth/plan.ts`)

Not used in Stage 1A but PREPARED. Skeleton only:

```ts
export const requirePlan = (allowed: ('free' | 'pro')[]) => async (c, next) => {
  const user = c.get('user');
  // TODO(Stage 3): once Subscription module exists, read user's active subscription
  // and check user.plan against `allowed`. For now this is a no-op pass-through;
  // ALL real plan checks land in Stage 3 + per-endpoint in their respective stages.
  await next();
};
```

This keeps the future call sites stable without enforcing plan logic before Subscription module exists. Mark with the TODO.

### 4.3 `src/lib/jwt.ts`, `src/lib/password.ts`, `src/lib/cookies.ts`, `src/lib/lockout.ts`

Small focused files. No business logic, just primitives:

- `jwt.ts` — `signAccessToken(payload)`, `verifyAccessToken(token)`. Uses `jose` (modern, no Buffer polyfill issues).
- `password.ts` — `hashPassword(plain)`, `verifyPassword(plain, hash)`. Uses `bcryptjs` (pure JS, no node-gyp; performance is fine for cost 12).
- `cookies.ts` — `setSessionCookie(c, jwt)`, `setRefreshCookie(c, refreshToken)`, `clearAuthCookies(c)`. Reads `isProduction` from `config` to flip `Secure`.
- `lockout.ts` — `recordFailedLogin(email)`, `clearLockout(email)`, `getLockoutState(email)`. Uses the shared Redis client.

## 5. Email module (minimum for Stage 1A only)

Single file: `src/modules/email/email.service.ts`. Two exported functions:

- `sendWelcomeEmail({ to, fullName })`
- `sendVerificationEmail({ to, fullName, verificationUrl })`

Each:
1. Builds a minimal HTML + text body (inline; no templating engine — Stage 15 may add one).
2. Calls Resend API via `fetch` (don't add the `resend` SDK package; it's a single HTTP call). Use `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` from config.
3. Wrap in try/catch. Log structured `{ event: 'email_sent', template, to, outcome: 'success'|'failed', error? }`.
4. **Does not throw.** The auth flow that called it is fire-and-forget by design (§2.9 async / non-blocking) — an email failure must not break registration.

If Resend returns 403 / "domain not verified" in dev, log it clearly so Idowu knows to either verify `neonfi.live` on Resend or switch `EMAIL_FROM_ADDRESS` to `onboarding@resend.dev`. Do not change `.env` from here.

Stage 15 will extend this module with subscription-confirmation, payment-receipt, refund, and cancellation emails plus retry logic. Stage 1A's module is the seed.

## 6. Tests (Vitest, integration)

Per System_Implementation §9 the Auth module REQUIRES integration tests against a real PG + Redis (not mocks). Implement these in `tests/auth.test.ts`:

1. Register a new user → User row exists with correct fields, `onboardingStatus.name === 'pending_verification'`, password hash is bcrypt-shaped.
2. Register duplicate email → `409 EMAIL_ALREADY_REGISTERED`.
3. Register with weak password (e.g. 7 chars) → `400 WEAK_PASSWORD`.
4. Login with right password → cookies set, Session row exists, refreshTokenHash populated.
5. Login with wrong password → `401`, no Session created, lockout counter incremented.
6. Login 5 times wrong → 6th attempt returns `423 ACCOUNT_LOCKED`.
7. Login with right password → lockout counter cleared.
8. Logout → Session.revokedAt set; cookies cleared.
9. Verify-email with valid token → onboardingStatus transitions to `verified`, token deleted from Redis.
10. Verify-email with stale/missing token → `400 INVALID_VERIFICATION_TOKEN`.
11. Refresh with valid refresh cookie → new `session` cookie issued; refresh cookie unchanged.
12. Refresh with revoked session → `401 SESSION_EXPIRED`.

**Test DB setup:**

The Build Guide §3.2 calls for `DATABASE_URL_TEST` and `REDIS_URL_TEST` separate from dev. For Stage 1A you don't have those yet. Two choices:

- **(a)** Tell Idowu to add a Neon dev branch (or a new branch) and a separate Memurai instance, then add the test URLs to `.env`. Real isolation. Right way long term.
- **(b)** Use the dev DB + Redis with a per-test prefix and aggressive cleanup (truncate tables in `beforeEach`). Cheaper short term, risk of polluting dev data if a test crashes mid-run.

**STOP and ask** which Idowu wants. Do not silently use the dev DB; tests are state-destructive (they delete users between cases).

## 7. STOP-AND-ASK gates (in order)

1. **Before the schema migration**: confirm with Idowu that adding `Session.refreshTokenHash String @unique @db.VarChar(64)` is acceptable (§1.2 — it's a schema delta beyond the docx and adds to the doc-fix pile).
2. **Before tests**: §6 above — which test-DB strategy.
3. **If Resend domain isn't verified** when you first call it: log the 403 response clearly and tell Idowu the verify-domain-or-switch-sender choice. Do not silently swap `EMAIL_FROM_ADDRESS`.
4. **If the JWT/bcrypt libraries fail to install** (Windows node-gyp issues with native bcrypt): switch to `bcryptjs` (pure JS) without asking — that's the documented fallback. Just note it in the commit.

## 8. What NOT to do

- **No Stage 1B endpoints.** No `/auth/google`, no `/auth/sessions` GET, no `/auth/sessions/{id}` DELETE, no `/auth/ws-token`. Those land in the next prompt.
- **No `/users/me`.** That's Stage 2. The auth endpoints in this prompt return user data inline; the dashboard fetches `/users/me` later.
- **No `/subscriptions/*`.** Stage 3.
- **No portfolios, assets, transactions, NFTs, snapshots, analytics, prices, webhooks.** Their stages own them.
- **No WebSocket server.** Stage 10. Leave `src/ws/server.ts` placeholder untouched.
- **No new envelope helpers.** Use `ok()` / `err()` from `src/lib/envelope.ts`.
- **No new Prisma client instances.** Use `src/lib/prisma.ts` singleton.
- **No new Redis client instances.** Use `src/lib/redis.ts` singleton.
- **No adding a `name` column to User** (Gate C).
- **No adding an `emailVerified` column to User** (Gate D — DERIVE only).
- **No changing the schema's id-strategy.** No UUIDs anywhere.
- **No editing `docs/*.docx`** — schema-delta surfacing goes in code comments + this report.
- **No `prisma migrate reset`**.
- **No silent password-policy variations.** Use §1.5 verbatim.
- **No storing raw refresh tokens in DB** — hash with SHA-256 before insert.
- **No JWT for the refresh token.** Opaque random bytes only; the Session row IS the state.
- **No setting cookies' Domain attribute.** Origin-scoped is correct here.
- **No `Authorization` header reading.** Cookies only.
- **No third-party auth middleware libraries** (e.g. `@auth/core`, NextAuth, lucia). Hand-roll using `jose` + `bcryptjs` + Hono primitives. Single-stack ownership.
- **No `npm audit fix`.**

## 9. Commit and report

```bash
git add -A
git commit -m "feat(auth): Stage 1A — email registration/login/logout/verify/resend/refresh + email module"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation each of the six endpoints returns the documented status codes (curl one happy path + one error path per endpoint).
- Vitest output: all 12 tests passing.
- The schema delta you applied (refreshTokenHash column).
- The two new env vars added to `.env.example` (AUTH_LOGIN_MAX_ATTEMPTS, AUTH_LOGIN_LOCKOUT_MS).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
