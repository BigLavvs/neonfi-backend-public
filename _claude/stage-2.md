# Neonfi backend — Stage 2: Users / profile

This file is the source-of-truth intent for Stage 2. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `ef0d0cc` (Stage 1B — all 10 auth endpoints + 34 tests).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` and `_claude/stage-1b.md` (this repo) — Stage 2 reuses `requireAuth`, `users.repository`, `toUserDTO()` (the user DTO helper Stage 1A built), and the standard envelope helpers. The Gate C (displayName not name) and Gate D (emailVerified derived) decisions LOCKED in Stage 1A apply unchanged here.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `C:\Users\pelum\Desktop\Neonfi\docs\`) — **§Stage 2 in full**, **§0.4** (locked decisions), **§2.3** (envelopes), **§2.4** (pagination — not used here but worth re-skimming).
3. `src/modules/users/users.contract.ts` — Gates C + D, re-read for orientation.
4. `prisma/schema.prisma` — User model fields you'll touch: `fullName`, `displayName`, `avatarUrl`, `newsletterSubscribed`, plus the relations to `AuthProvider` and `OnboardingStatus`.
5. The frontend's `src/routes/(dashboard)/settings/+page.svelte` (frontend repo) — the consumer of these endpoints. Read it to see what fields it reads/writes and how it gates the password section. The key line is `data.user.authProvider === 'google'` controlling password-section visibility.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Stage 2 scope = profile read + profile write, nothing else [PICKED]

The Build Guide's **Implements** line for Stage 2 mentions "change password (email users only)" and "delete account" alongside profile read/write. The **Endpoints** line lists only `GET /users/me` and `PATCH /users/me`. These don't fully agree.

Resolution for this prompt: **build only the two endpoints**. Password change and account deletion are NOT in scope here. Both are surfaced as doc-fix items for Idowu — they need either (a) new endpoints documented in `Neonfi System Architecture.docx` (e.g. `POST /users/me/password`, `DELETE /users/me`) or (b) explicit "out of scope for MVP" notes if they're being deferred. Either way, Stage 2 builds the documented surface and stops there.

If during build you find the frontend's `/settings` page calls a password-change or delete-account endpoint, **STOP and surface** — the spec needs to be updated before you build them.

### 1.2 PATCH semantics: partial update, all fields optional

The frontend's `/settings` page edits fields independently (e.g. just newsletter toggle, just display name). PATCH /users/me accepts any subset of:

- `fullName` (string, 1–255 chars)
- `displayName` (string, 1–100 chars)
- `avatarUrl` (string URL, 1–2048 chars, or `null` to clear)
- `newsletterSubscribed` (boolean)

All optional. Empty body → 200 no-op (returns current user). Unknown fields → 400 `VALIDATION_ERROR` (use Zod `.strict()` so an attempt to PATCH `email` or `plan` or `passwordHash` is rejected explicitly).

### 1.3 Response shape: reuse `toUserDTO()` from Stage 1A

GET /users/me and PATCH /users/me both return `{ data: { user: <UserDTO> } }`. `<UserDTO>` is the shape Stage 1A already established for register/login responses. Reuse `toUserDTO()` — do not invent a parallel mapper. If Stage 1A put it inline in `auth.service.ts`, lift it into `users.repository.ts` (or a new `users/users.dto.ts`) so the users module is the canonical owner. Update Stage 1A's auth.service to import from there.

The DTO returns:
- `id` (number)
- `email` (string)
- `fullName` (string)
- `displayName` (string | null)
- `avatarUrl` (string | null)
- `authProvider` (string: `'email'` or `'google'` — resolved from the FK row, never the FK id)
- `emailVerified` (boolean — derived per Gate D)
- `onboardingStatus` (string: one of the four seeded values — resolved from FK)
- `plan` (string `'free'` | `'pro'` OR `null`) — `null` until the user has a Subscription row (Stage 3 builds Subscription; until then every user is plan-less)
- `billingCycle` (string `'monthly'` | `'yearly'` | `null`) — likewise null until Stage 3
- `newsletterSubscribed` (boolean)
- `createdAt` (ISO timestamp)
- `updatedAt` (ISO timestamp)

Do NOT expose: `passwordHash`, `authProviderId`, `onboardingStatusId`. Do NOT add a synthetic `name` field — the frontend client auth store does the `name = displayName ?? fullName` fallback per Gate C.

### 1.4 Privacy: own record only — implicit via session

Both endpoints use the `requireAuth` middleware from Stage 1A. The "user" the endpoints act on is `c.get('user')` — the requesting session's user. There's no path/query parameter to a different user; this is structurally enforced. No additional ownership check needed.

This satisfies the privacy rule "Current user == id: 200 (Read and write); Others: 403" because there's no way to address a different user from these endpoints. The architecture's `/users/me` is canonical — there's no `/users/{id}` exposed.

## 2. Module scope

```
src/modules/users/users.controller.ts   # NEW — mounts at /api/v1/users
src/modules/users/users.service.ts      # NEW — small (read profile, update profile)
src/modules/users/users.schemas.ts      # NEW — PATCH body Zod schema
src/modules/users/users.repository.ts   # EXTEND — add updateProfile() if not present
src/modules/users/users.dto.ts          # NEW (or repurpose existing helper location) — toUserDTO()
src/app.ts                              # mount users router at /api/v1/users
src/modules/auth/                       # EDIT — refactor toUserDTO() import to users module
tests/users.test.ts                     # NEW — 12 integration tests
tests/auth.test.ts                      # UNCHANGED — verify all 34 existing pass after refactor
```

Do NOT touch any other module directory. They keep their `.gitkeep`.

## 3. Endpoints

### 3.1 `GET /users/me` — read own profile

**`requireAuth` middleware required.**

**Flow:**
1. Read `c.get('user')` (already loaded by middleware, but middleware loads it without `subscription`).
2. Re-fetch with `subscription { plan, billingCycle, status }` included if we need plan/billingCycle on the DTO. (See §1.3 — plan/billingCycle null until Subscription exists, so for Stage 2 the simpler path is: skip the re-fetch, return `plan: null` and `billingCycle: null` unconditionally, with a TODO comment naming Stage 3 as the activation point.)
3. Map through `toUserDTO()`.
4. Respond: `200 { data: { user: <UserDTO> } }`.

**Performance:** this endpoint is hot — the frontend calls it on every dashboard load. The user is already on the Hono context from middleware; do NOT re-query unless you're populating plan/billingCycle. Keep it to one DB round-trip max.

### 3.2 `PATCH /users/me` — update own profile

**`requireAuth` middleware required.**

**Request:** all fields optional. Use Zod `.strict()` so unknown fields are 400.

```json
{
  "fullName":             "<string, 1-255>",
  "displayName":          "<string, 1-100, or null>",
  "avatarUrl":            "<URL string, 1-2048, or null>",
  "newsletterSubscribed": <boolean>
}
```

**Flow:**
1. Validate body (Zod). Unknown field → `400 VALIDATION_ERROR` with the field name in the meta. Invalid value → `400 VALIDATION_ERROR`.
2. If body is empty (`{}`): no-op. Return current user via `toUserDTO()`.
3. Otherwise: `prisma.user.update({ where: { id: user.id }, data: <validated body>, include: { authProvider: true, onboardingStatus: true } })`.
4. Map through `toUserDTO()`.
5. Respond: `200 { data: { user: <UserDTO> } }`.

**Field handling notes:**
- `displayName: null` clears it (the schema column is nullable). `displayName: ""` is rejected (Zod min 1). The frontend client auth store will then fall back to `fullName` for display.
- `avatarUrl: null` clears it. `avatarUrl: ""` is rejected. Validate it as a URL (Zod `.url()`).
- `fullName: ""` is rejected (Zod min 1) — a user must always have a `fullName` since the schema column is non-nullable.
- `newsletterSubscribed`: plain boolean. No further validation.

**Out of scope for PATCH /users/me in this stage** (do NOT accept these fields):
- `email` — changing email implies re-verification and re-issuing sessions. Out of scope; surface as a doc-fix item.
- `password` / `currentPassword` / `newPassword` — password change is deferred (see §1.1).
- `plan` / `billingCycle` / `onboardingStatus` — these are server-managed, never client-settable.
- `authProvider` — immutable.
- `id`, `createdAt`, `updatedAt`, `passwordHash` — never client-settable.

`.strict()` will reject these automatically, but explicitly call them out in a comment so the next implementer doesn't try to add them.

## 4. Wiring

### 4.1 Mount the users router

In `src/app.ts`, after the auth router:

```ts
import { usersRouter } from './modules/users/users.controller.js';
// ...
app.route('/api/v1/users', usersRouter);
```

### 4.2 Refactor `toUserDTO()` location

If Stage 1A put `toUserDTO()` inside `src/modules/auth/auth.service.ts` (or similar), move it to `src/modules/users/users.dto.ts` (or `users.repository.ts` if a separate dto file feels like overkill — pick one and be consistent). Update the auth.service.ts imports. Run the existing 34 auth tests after the refactor — they MUST still all pass; if one breaks, the refactor introduced a regression and you should STOP.

The refactor is in scope for Stage 2 because Stage 2 owns the users module surface; Stage 1A only built `toUserDTO()` because no users module endpoints existed yet.

## 5. Tests (Vitest, integration — new file `tests/users.test.ts`)

Same cleanup pattern as `auth.test.ts` (per-test truncate of `session` and `user`, clear auth Redis keys). Same dev DB. Reuse the helpers (`post`, `get`, `del`, `cookieValue`, `registerTestUser`, `loginTestUser`) — extract them into `tests/helpers.ts` if you find yourself copy-pasting more than two, otherwise inline.

35. **GET /users/me with auth** → 200 with full DTO. Verify all fields present, `plan: null`, `billingCycle: null`, `emailVerified` derived correctly for a pending_verification user (false). No `passwordHash` in response.
36. **GET /users/me — verified user** → `emailVerified: true` after running verify-email first.
37. **GET /users/me — no auth** → 401 `UNAUTHENTICATED`.
38. **PATCH /users/me — update displayName** → 200, DB row reflects new value.
39. **PATCH /users/me — update fullName** → 200, DB row reflects new value.
40. **PATCH /users/me — update avatarUrl** → 200, DB row reflects new value.
41. **PATCH /users/me — avatarUrl: null** → 200, DB row's avatarUrl is null.
42. **PATCH /users/me — toggle newsletterSubscribed** → 200, DB row reflects new value.
43. **PATCH /users/me — multiple fields at once** → 200, all updated atomically.
44. **PATCH /users/me — empty body** → 200, returns current user (no DB write needed, but writing an empty update is also fine).
45. **PATCH /users/me — unknown field (e.g. `email`)** → 400 `VALIDATION_ERROR`.
46. **PATCH /users/me — fullName too long (>255 chars)** → 400.
47. **PATCH /users/me — displayName empty string** → 400 (use null to clear).
48. **PATCH /users/me — avatarUrl not a URL** → 400.
49. **PATCH /users/me — no auth** → 401.
50. **PATCH /users/me — readback** → after PATCH succeeds, a follow-up GET returns the updated values (verifies the PATCH response and the persisted state agree).

Total after Stage 2: **50 tests** (34 auth + 16 users).

## 6. STOP-AND-ASK gates

1. **If the frontend `/settings` page calls a password-change or account-delete endpoint** (look for `POST /users/me/password`, `DELETE /users/me`, or similar in `src/routes/(dashboard)/settings/+page.svelte`), **STOP** and surface to Idowu. The spec needs to be updated before building those.
2. **If `toUserDTO()` doesn't exist in Stage 1A's output** (e.g. Stage 1A inlined the shape inside register/login handlers instead of factoring it out), create it now and refactor Stage 1A to use it. Note this in the commit message. Do not duplicate the shape.

## 7. What NOT to do

- **No password change endpoint.** Deferred (§1.1).
- **No account deletion endpoint.** Deferred (§1.1) — surface as doc-fix item in the commit message and the report.
- **No `/users/{id}` endpoints.** Privacy: own record only via `/users/me`.
- **No email change via PATCH /users/me.** Out of scope (§3.2 "Out of scope" list).
- **No accepting `plan`, `billingCycle`, `onboardingStatus`, `authProvider`, or `passwordHash` in the PATCH body.** Server-managed only; `.strict()` rejects.
- **No new schema changes.** All User columns we need already exist.
- **No new env vars.**
- **No subscription/plan logic.** Stage 3.
- **No exposing `passwordHash`, `authProviderId`, `onboardingStatusId` in any response.** DTO only.
- **No synthetic `name` field in the response.** Gate C — frontend handles the displayName→name mapping.
- **No new email sends from these endpoints.** PATCH /users/me must NOT trigger any email (not even for newsletter changes; the toggle is the source of truth for whether they receive newsletters at all, and the welcome/verification emails already shipped at registration).
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(users): Stage 2 — GET /users/me + PATCH /users/me + toUserDTO refactor"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation each of the two endpoints returns the documented status codes (one happy path + one error path each).
- Vitest output: all 50 tests passing (34 existing + 16 new).
- Where `toUserDTO()` lives now (path).
- **Doc-fix pile items** added in Stage 2:
  - `DELETE /users/me` (account deletion) — not in `Neonfi System Architecture.docx` URL list; either add it or document as out-of-scope.
  - `POST /users/me/password` (password change for email users) — same situation.
  - Email change flow — not documented anywhere; needs spec before any future PATCH-email support.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
