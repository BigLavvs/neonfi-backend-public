# Neonfi backend — Stage 1B: Google OAuth + session list/revoke + WS ticket

This file is the source-of-truth intent for Stage 1B. Build from this; report back to Idowu when done. With Stage 1B, all 10 Stage-1 auth endpoints are complete.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `ff7ad27` (Stage 1A — six email-auth endpoints + tests).

## 0. Read first

In this order, the entire file each time:

1. `_claude/stage-1a.md` (this repo) — Stage 1B reuses Stage 1A's primitives (cookies, JWT, requireAuth middleware, AuthError, users.repository functions, ok/err envelope). Skim §1 (architecture decisions) and §4 (cross-cutting wiring) so you know what's already in place.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo at `C:\Users\pelum\Desktop\Neonfi\docs\`) — **§Stage 1 in full** (esp. the WS ticket contract, Google OAuth flow notes, and onboarding-state transitions); **§2.7** (WebSocket envelope — relevant only because we're issuing the ticket, not implementing the WS); **§2.2** (auth/session).
3. `src/modules/auth/` — what Stage 1A built. The patterns in `auth.service.ts`, `auth.controller.ts`, `middleware.ts`, and `auth.schemas.ts` are the template; Stage 1B follows the same shape.
4. `src/modules/users/users.repository.ts` — `findUserByEmail`, `createUser`, `createSession`, `revokeSession`, `findActiveSessionsByUser` (if it exists; else add it). DO NOT add a second User repo.
5. `prisma/schema.prisma` — User, Session, AuthProvider models. Verify field names against what you write.
6. The frontend's `src/lib/ws.ts` and `(dashboard)/+layout.svelte` (frontend repo). The WS ticket consumer side. The ticket endpoint MUST return `{ data: { token, expiresIn } }` — the frontend reads `res.data.token` (`(dashboard)/+layout.svelte:34`).

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions for this prompt (record in code comments)

### 1.1 Google OAuth — server-redirect (auth-code) flow [DECIDED]

**Idowu chose Option 1 (server-redirect).** The frontend `(public)/register/+page.svelte` already uses `window.location.href` to send the browser to a backend endpoint; we build the standard OAuth 2.0 web-app flow to match. **No frontend change required.** Two backend endpoints: one to initiate, one to receive the callback.

Use **`google-auth-library`** (the official Google Node.js library, ~600KB, no native deps). Pattern:

```ts
import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.GOOGLE_REDIRECT_URI,
});

// In GET /auth/google: build the authorization URL.
const authUrl = client.generateAuthUrl({
  scope: ['openid', 'email', 'profile'],
  state,
  prompt: 'select_account',
});

// In GET /auth/google/callback: exchange the code, then verify the id_token.
const { tokens } = await client.getToken(code);
const ticket = await client.verifyIdToken({
  idToken: tokens.id_token!,
  audience: config.GOOGLE_CLIENT_ID,
});
const payload = ticket.getPayload();
// payload.email, payload.email_verified, payload.name, payload.picture, payload.sub
```

**CSRF protection — required for the auth-code flow:**
Bind the `state` token to the browser via BOTH (a) a short-lived HttpOnly cookie set during the redirect AND (b) a Redis key. Callback verifies *both* — query `state` matches cookie value AND Redis key exists. This prevents OAuth login CSRF (attacker creates a flow, tricks victim's browser into receiving the callback, ending up logged in as the attacker).

Reject the callback (always by redirecting to the frontend with an error query param — never a JSON 401) if:
- `oauth_state` cookie missing.
- `state` query doesn't match cookie value.
- Redis `oauth_state:<state>` key missing (replayed, expired, or never created).
- `getToken` throws (bad/expired code, mismatched redirect_uri).
- `verifyIdToken` throws (signature, audience, expiry).
- `payload.email` missing OR `payload.email_verified !== true`.

The browser is the consumer of these endpoints; everything is URL-based. There are no JSON 4xx responses from `/auth/google/*` — failures redirect to `${APP_BASE_URL}/register?oauth_error=<reason>`.

### 1.2 Account-linking policy — refuse merge

If a user with the same email already exists AND that user's `authProvider.name === 'email'` (registered with email/password before), **refuse the Google login** with `409 ACCOUNT_EXISTS_DIFFERENT_PROVIDER`. Tell the frontend the email is owned by a different auth provider. Do NOT auto-merge.

Rationale: Stage 1B is the wrong place to design an account-linking flow. The conservative refusal is reversible later when (and if) a real linking flow is built. The opposite (auto-merge) is not reversible without DB surgery.

If the existing user IS a Google user (`authProvider.name === 'google'`), proceed as login — find them, create a new Session, set cookies, return user info. Same path as a returning Google login.

### 1.3 Google user state on first login

Per Build Guide §Stage 1: Google-authenticated users skip `pending_verification` and start at `onboardingStatus = 'verified'` immediately. Use the lookup-table FK; no string values stored.

- `authProvider` row: `name = 'google'`.
- `onboardingStatus` row: `name = 'verified'`.
- `passwordHash = NULL` (Google users have no password — schema permits this).
- `fullName` from `payload.name`, fallback to email-local-part if absent.
- `displayName` initially set equal to `fullName` (frontend can rename later via PATCH /users/me at Stage 2).
- `avatarUrl` from `payload.picture` (Google provides a profile photo URL); optional, fine to leave null if absent.
- `emailVerified` is still DERIVED per Gate D — no column. The derivation gives `true` because `onboardingStatus !== 'pending_verification'`.

### 1.4 WS ticket — single-use, 60-second Redis TTL

The ticket is an opaque random token, **not a JWT**. It's the throwaway used to authenticate the WebSocket handshake (Stage 10 consumes it). Build the issuer here; Stage 10 builds the consumer.

- 32 random bytes → base64url-encoded string.
- Redis key: `ws_ticket:<ticket>` → value `<userId>:<sessionId>`.
- TTL: 60 seconds.
- Response: `{ data: { token: <ticket>, expiresIn: 60 } }` — exact shape per `(dashboard)/+layout.svelte:34`.
- **No plan check here.** Per §Stage 1: free users are rejected at the WS handshake (4001 close), not at ticket-fetch time. The endpoint just requires authentication. Stage 10's handshake will check the user's plan against the ticket's user and 403/close as appropriate.
- Each call issues a new ticket. Don't cache or reuse.

### 1.5 Session listing — active sessions only

`GET /auth/sessions` returns the current user's `revokedAt IS NULL AND expiresAt > now` sessions. Don't expose revoked or expired rows. Include a `current: boolean` field marking the session that issued the current request (matched by `sessionId` from the JWT). The frontend uses this to grey out the "revoke" button on the current session (or rename it to "log out here").

### 1.6 DELETE /auth/sessions/{id} — ownership + self-revoke side-effect

- Ownership: session.userId MUST equal the requesting user's id. Cross-user → `403 FORBIDDEN`. Surface the same code whether the session belongs to another user or doesn't exist at all (prevents session-id enumeration).
- If the requested session IS the requesting session (sessionId from JWT === path param): also clear both cookies (it's effectively a logout). Respond `200 { data: { ok: true, loggedOut: true } }` so the frontend knows.
- Otherwise: just set `revokedAt`, respond `200 { data: { ok: true, loggedOut: false } }`.
- Already-revoked session: idempotent — return `200` without re-writing `revokedAt`. Don't 404 a session that exists but is revoked; that leaks information about session state to whoever guessed the id.

## 2. Module scope for this prompt

You build/edit code in these locations only:

```
src/modules/auth/auth.service.ts        # add: googleLogin(), listSessions(), revokeSessionById(), issueWsTicket()
src/modules/auth/auth.controller.ts     # add: 4 new routes
src/modules/auth/auth.schemas.ts        # add: GoogleLoginSchema, SessionIdParamSchema
src/modules/users/users.repository.ts   # add (if missing): findActiveSessionsByUser(), findSessionById()
src/lib/                                # NO new files in Stage 1B
prisma/                                 # NO schema changes in Stage 1B (Session already has every column we need)
tests/auth.test.ts                      # add ~11 tests; keep the existing 12 untouched
```

Do NOT touch any other module directory. They keep their `.gitkeep`.

## 3. Endpoints in this prompt (4 of 10 total auth endpoints — the remaining 4)

Build them in this order.

### 3.1 Google OAuth — two endpoints, no JSON responses

The frontend hits these as top-level browser navigations, not as fetch() calls. Everything is HTTP redirect + cookies. Failures redirect to `${APP_BASE_URL}/register?oauth_error=<reason>` so the frontend register page can render a sensible error message (that frontend rendering is out of scope here — Stage 1B just sets the contract).

#### 3.1a `GET /auth/google` — initiate OAuth flow

**No auth.** Query: optional `?return_to=<path>` — frontend path to redirect to after successful login. Default `/dashboard`. Validation: must start with `/`, must NOT contain `:` or `//` (prevents open-redirect to `https://evil.com`). If invalid, silently use the default — don't 400; this is a UX endpoint and noisy errors here are unhelpful.

**Flow:**
1. Generate `state`: 32 random bytes, base64url-encoded.
2. Store in Redis: `oauth_state:<state>` → JSON `{ returnTo, createdAt: <iso> }`, TTL 600 seconds.
3. Set HttpOnly cookie `oauth_state` with value `<state>`:
   - `HttpOnly`
   - `SameSite=Lax` (the callback is a top-level navigation from google.com, so `Strict` would silently drop the cookie)
   - `Secure` when `NODE_ENV === 'production'`
   - `Path=/api/v1/auth/google` (scope to the OAuth flow paths only — cookie won't leak to other endpoints)
   - `Max-Age=600`
4. Build Google authorization URL with `client.generateAuthUrl({ scope: ['openid','email','profile'], state, prompt: 'select_account' })`.
5. Respond: `302 Location: <authorization URL>`. No body.

#### 3.1b `GET /auth/google/callback` — receive code, exchange, authenticate

**No auth.** Query: `code`, `state`, optional `error` (Google sets `error=access_denied` if the user declines consent).

**Flow:**
1. If `error` query is present (e.g. `access_denied`): redirect `302 Location: ${APP_BASE_URL}/register?oauth_error=access_denied`. Clear the `oauth_state` cookie. No session created.
2. Read `oauth_state` cookie. If absent: redirect to `${APP_BASE_URL}/register?oauth_error=invalid_state`.
3. Compare cookie value to the `state` query param. If mismatch: redirect to `${APP_BASE_URL}/register?oauth_error=invalid_state`.
4. `GETDEL` `oauth_state:<state>` from Redis. If null: redirect to `${APP_BASE_URL}/register?oauth_error=invalid_state` (replayed or expired).
5. Parse the JSON value to recover `returnTo`. Clear the `oauth_state` cookie (Max-Age=0, same Path scoping as the set).
6. Exchange code for tokens: `await client.getToken(code)`. On throw: redirect to `${APP_BASE_URL}/register?oauth_error=invalid_token`.
7. Verify the returned `id_token` via `client.verifyIdToken`. Check `payload.email_verified === true`. On any failure: redirect to `${APP_BASE_URL}/register?oauth_error=invalid_token`.
8. Extract `email` (lowercased), `name`, `picture`, `sub`.
9. **Three cases** (transaction-bracketed where DB mutations happen):
   - **(a) No existing user:** Create User with `authProvider.name='google'`, `onboardingStatus.name='verified'`, `passwordHash=NULL`, `fullName=name ?? <email-local-part>`, `displayName=name ?? <email-local-part>`, `avatarUrl=picture ?? null`. Treat as **newly registered**.
   - **(b) Existing Google user (`authProvider.name='google'`):** Use the existing User. Treat as **returning login**.
   - **(c) Existing email user (`authProvider.name='email'`):** Redirect to `${APP_BASE_URL}/register?oauth_error=email_in_use_with_password`. No session created. Per §1.2 — refuse account merge.
10. Create Session (Stage 1A pattern — `refreshTokenHash`, IP from `x-forwarded-for` chain or `x-real-ip`, userAgent).
11. Set `session` + `refresh` cookies via the Stage 1A helpers (`setSessionCookie`, `setRefreshCookie`).
12. Respond: `302 Location: ${APP_BASE_URL}${returnTo}`. No body.

There is no `newlyRegistered` field in any response — there's no body to put it in. If the frontend ever needs to differentiate first-login vs. returning, that's queryable from `GET /users/me` (Stage 2) by inspecting `createdAt`.

### 3.2 `GET /auth/sessions` — list active sessions

**`requireAuth` middleware required.**

**Flow:**
1. Load all sessions for `c.get('user').id` where `revokedAt IS NULL AND expiresAt > now`.
2. Map each to `{ id, ipAddress, userAgent, createdAt, expiresAt, current: <boolean> }`. `current = (session.id === c.get('session').id)`. Do NOT return `userId` (privacy: redundant + leaks the user's own ID, which they already know).
3. Sort by `createdAt DESC` (newest first).
4. Respond: `200 { data: { sessions: [...] }, meta: { total: <count> } }`.

### 3.3 `DELETE /auth/sessions/{id}` — revoke specific session

**`requireAuth` middleware required.**

**Request:** `id` is a path param (positive integer; validate with Zod or `c.req.param`).

**Flow:**
1. Parse `id` (positive integer). Invalid → `400 VALIDATION_ERROR`.
2. Load session by id. If not found OR session.userId !== current user.id: `403 FORBIDDEN`. (Single error for both cases — no enumeration leak.)
3. If `revokedAt` already set: respond `200 { data: { ok: true, loggedOut: false } }`. (Idempotent.)
4. Set `revokedAt = now`. Commit.
5. If the revoked session IS the current session (`session.id === c.get('session').id`): clear both cookies. Respond `200 { data: { ok: true, loggedOut: true } }`.
6. Else: respond `200 { data: { ok: true, loggedOut: false } }`.

### 3.4 `GET /auth/ws-token` — WS handshake ticket

**`requireAuth` middleware required.**

**Flow:**
1. Generate 32 random bytes → base64url-encoded string.
2. Store in Redis: `ws_ticket:<ticket>` → `${user.id}:${session.id}` with TTL 60s.
3. Respond: `200 { data: { token: <ticket>, expiresIn: 60 } }` — exact shape per `(dashboard)/+layout.svelte:34`. No `meta`.

**No plan check.** Free users will be 4001-closed at the WS handshake in Stage 10; here they just get a ticket that won't admit them. That's per §Stage 1 flow.

## 4. Cross-cutting wiring (mostly reused from Stage 1A)

### 4.1 New env var: GOOGLE_REDIRECT_URI

Add a new required env var to BOTH `src/lib/config.ts` (Zod schema, validated as a URL) and `.env.example`:

```
GOOGLE_REDIRECT_URI=https://api.neonfi.live/api/v1/auth/google/callback
```

Local dev value (Idowu will fill in):
```
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/google/callback
```

**Idowu MUST register both URIs** in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Authorized redirect URIs, BEFORE the flow will work. Without registration, Google rejects the callback with `redirect_uri_mismatch` and the user lands on Google's error page. Surface this requirement in the commit message AND in the final report so Idowu doesn't get surprised by a confusing Google error.

Do NOT try to derive the redirect URI from `API_BASE_URL` — make it explicit. This decouples the OAuth callback URL from any future proxy/path-rewrite arrangement.

### 4.2 Auth middleware

Reuse `requireAuth` from Stage 1A (`src/modules/auth/middleware.ts`) for `/sessions`, `/sessions/{id}`, and `/ws-token`. No changes needed to the middleware itself.

### 4.3 New repository functions

If they don't already exist in `users.repository.ts`, add them:

- `findActiveSessionsByUser(userId: number): Promise<Session[]>` — `WHERE userId = ? AND revokedAt IS NULL AND expiresAt > NOW()`.
- `findSessionById(id: number): Promise<Session | null>` — straight lookup.

If they exist with different signatures, use what's there. Don't duplicate.

### 4.4 No changes to other lib files

`jwt.ts`, `password.ts`, `cookies.ts`, `lockout.ts` — untouched. Stage 1B doesn't need new primitives.

## 5. Tests (Vitest, integration — extend existing `tests/auth.test.ts`)

Add these to the existing 12 Stage 1A tests. Keep the existing tests untouched. Total: **32 tests after Stage 1B** (12 existing + 20 new).

**Google OAuth: mock `google-auth-library` since you can't get real Google ID tokens or real Google callbacks in tests.** Stub BOTH `OAuth2Client.prototype.getToken` and `OAuth2Client.prototype.verifyIdToken` at the top of the Google OAuth `describe` block; reset stubs between tests. Use `vi.mock('google-auth-library', () => ({ OAuth2Client: vi.fn().mockImplementation(() => ({ generateAuthUrl: ..., getToken: ..., verifyIdToken: ... })) }))` or similar.

Hono's `app.request()` returns `Response` objects with status + headers — that's what you assert against for redirects (`expect(res.status).toBe(302); expect(res.headers.get('location')).toMatch(...)`).

### 5.1 GET /auth/google (initiate)

13. **happy path, no return_to** → 302; Location starts with `https://accounts.google.com/o/oauth2/v2/auth`; `oauth_state` cookie set with HttpOnly+Lax+Path=/api/v1/auth/google; Redis `oauth_state:<state>` exists with `returnTo='/dashboard'` and TTL > 0.
14. **with `?return_to=/wallet`** → Redis value has `returnTo='/wallet'`.
15. **open-redirect attempt `?return_to=https://evil.com`** → Redis value has `returnTo='/dashboard'` (defaulted silently); no 4xx response.

### 5.2 GET /auth/google/callback

For all callback tests, seed Redis with a valid `oauth_state` key and set the `oauth_state` cookie on the request, unless the test is specifically about that path failing.

16. **new Google user, happy path** → mocked `getToken`+`verifyIdToken` return a payload with `email_verified: true`, unused email, name 'Test User'; expect 302 to `${APP_BASE_URL}/dashboard`; User row created with `authProvider.name='google'`, `onboardingStatus.name='verified'`, `passwordHash` null; Session created; `session`+`refresh` cookies set on the response.
17. **returning Google user** → pre-create a Google User in the DB; expect 302 to dashboard; user count unchanged (no new row); new Session row created.
18. **existing email user** → pre-create a User with `authProvider.name='email'` and the same email Google returns; expect 302 to `${APP_BASE_URL}/register?oauth_error=email_in_use_with_password`; no Session created.
19. **missing `oauth_state` cookie** → expect 302 to `?oauth_error=invalid_state`; no Session.
20. **state cookie/query mismatch** → expect 302 to `?oauth_error=invalid_state`.
21. **state not in Redis (replay or expired)** → expect 302 to `?oauth_error=invalid_state`.
22. **`getToken` throws** → expect 302 to `?oauth_error=invalid_token`.
23. **`verifyIdToken` throws** → expect 302 to `?oauth_error=invalid_token`.
24. **`email_verified: false`** → expect 302 to `?oauth_error=invalid_token`; no User created.
25. **`error=access_denied` in query** → expect 302 to `?oauth_error=access_denied`; `oauth_state` cookie cleared; no User/Session.

### 5.3 GET /auth/sessions

26. **auth** → 200 with `data.sessions` array of own active sessions; each item has `id, ipAddress, userAgent, createdAt, expiresAt, current`; NO `userId`; the requesting session has `current: true`, any others have `current: false`. `meta.total` matches array length.
27. **no auth** → 401 `UNAUTHENTICATED`.
28. **revoked/expired sessions filtered** → create a session with `revokedAt` set and another with `expiresAt` in the past; only the active session(s) return.

### 5.4 DELETE /auth/sessions/{id}

29. **own non-current session** → 200 with `{ ok: true, loggedOut: false }`; `revokedAt` set in DB.
30. **own current session** → 200 with `{ ok: true, loggedOut: true }`; `revokedAt` set; both auth cookies cleared in the response.
31. **another user's session** → 403 `FORBIDDEN` (seed a second user with a session, try to delete it as user A).
32. **non-existent id** → 403 `FORBIDDEN` (uniform with cross-user — no enumeration leak).

### 5.5 GET /auth/ws-token

33. **auth** → 200 with `data.token` non-empty string, `data.expiresIn: 60`; Redis `ws_ticket:<token>` exists with value `${userId}:${sessionId}` and TTL in (50, 61) seconds.
34. **no auth** → 401 `UNAUTHENTICATED`.

(Numbering continues from Stage 1A's tests 1–12. Final count: 34 tests in total — 12 from 1A + 22 new in 1B. Adjust if you find a sensible reason to combine cases.)

**Cleanup:** the `beforeEach` cleanup from Stage 1A truncates `session` and `user` and clears auth Redis keys. Verify it also clears `ws_ticket:*` AND `oauth_state:*` patterns — add them if missing. Clear `oauth_state` cookies between tests by passing a fresh Headers object on each `app.request()` call.

## 6. STOP-AND-ASK gates

1. **Before installing google-auth-library:** if `package.json` already has it (Claude Code may have added it in a previous attempt), skip the install. If not, install it as a runtime dep: `npm install google-auth-library`. No need to ask Idowu — this is the documented library choice.
2. **If the existing tests start failing** because of cleanup interaction with the new tests, STOP and surface — don't paper over it by reordering or skipping tests.

(The earlier gate about the frontend's OAuth flow shape is now resolved — Idowu picked Option 1, server-redirect. Build as specified above.)

## 7. What NOT to do

- **No Stage 2 endpoints.** No `GET /users/me`, no `PATCH /users/me`. The Google login response includes user info inline; the dashboard fetches `/users/me` later at Stage 2.
- **No /subscriptions/*.** Stage 3.
- **No portfolios, assets, transactions, NFTs, snapshots, analytics, prices, webhooks.** Their stages.
- **No WebSocket server.** Stage 10. You issue tickets; don't consume them. Leave `src/ws/server.ts` placeholder untouched.
- **No new envelope helpers.** Use `ok()` / `err()`.
- **No new Prisma client instances.** Use `src/lib/prisma.ts` singleton.
- **No new Redis client instances.** Use `src/lib/redis.ts` singleton.
- **No schema changes.** Session has every column we need; User has every column we need. If you find yourself wanting a column, STOP — the docx is the source of truth, and additions are surfaced not silently made.
- **No auto-merge of Google + email accounts** (§1.2 — refuse with 409).
- **No plan check in /auth/ws-token** (§1.4 — that's the WS handshake's job at Stage 10).
- **No JWT for the WS ticket.** Opaque random bytes only.
- **No exposing `userId` in the session list response.**
- **No 404 on revoked-or-missing sessions in DELETE /auth/sessions/{id}.** Use 403 uniformly.
- **No third-party OAuth library beyond google-auth-library.** No NextAuth, no @auth/core, no Auth0 SDK. Hand-roll the User-creation path; the only third-party piece is Google's signature verification + code exchange.
- **No real Google ID tokens or real callbacks in tests.** Mock both `OAuth2Client.prototype.getToken` AND `OAuth2Client.prototype.verifyIdToken`.
- **No JSON responses from `/auth/google` or `/auth/google/callback`.** Always 302 redirects. Errors surface via `?oauth_error=<reason>` on the redirect target.
- **No `oauth_state` cookie leakage.** Set `Path=/api/v1/auth/google` so it never gets sent to unrelated endpoints.
- **No frontend changes.** The frontend's `window.location.href` redirect to `${API_BASE_URL}/api/v1/auth/google` already works as-is for the server-redirect flow.
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(auth): Stage 1B — Google OAuth + session list/revoke + WS ticket"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation each of the four endpoint surfaces behaves per spec (one happy path + one error path per surface — note that `/auth/google` and `/auth/google/callback` count as one surface together).
- Vitest output: all **34 tests passing** (12 existing from Stage 1A + 22 new in Stage 1B).
- Whether `google-auth-library` was added as a new dep (yes/no).
- **The new env var `GOOGLE_REDIRECT_URI`** — flag explicitly in the report that Idowu must register the dev + prod values in Google Cloud Console → OAuth 2.0 Client → Authorized redirect URIs before the flow will work in either environment.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
