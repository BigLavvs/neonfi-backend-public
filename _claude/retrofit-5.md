# Neonfi backend — retrofit-5: Account deletion + notification preferences

Commit 1 of 4 in the frontend-audit remediation (see `_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `b933283` (retrofit-4).

Builds two `users`-surface gaps the frontend already has UI for: **account deletion** (`DELETE /users/me`,
settings Danger Zone) and **notification/display preferences** (`PATCH /users/preferences`, settings
Preferences tab). Both are deliberate spec extensions — the architecture/schema docs don't define them →
schema deltas land as `schema.prisma` NOTE comments + go on the docx-fix pile for Idowu.

## 0. Pre-verified state — what I read (re-verify before editing)

- `src/modules/users/users.controller.ts:22-48` — GET `/me` and PATCH `/me`, both `requireAuth`; PATCH does `PatchMeSchema.safeParse` → 400 on failure. Router mounted at `/api/v1/users` (app.ts:46).
- `src/modules/users/users.service.ts:9-22` — `getMe(user)` → `{user: toUserDTO}`; `updateMe(user, body)` → `updateProfile(user.id, body)`.
- `src/modules/users/users.schemas.ts:15-32` — `PatchMeSchema = z.object({fullName?, displayName?, avatarUrl?, newsletterSubscribed?}).strict()`.
- `src/modules/users/users.repository.ts` — `UserDTO` (24-39, already includes `newsletterSubscribed`), `toUserDTO` (41-73), `updateProfile(userId, {fullName?,displayName?,avatarUrl?,newsletterSubscribed?})` (182-196). No `deleteUser` yet.
- `src/modules/auth/auth.controller.ts:17` imports `deleteCookie` from `hono/cookie`; logout handler (128-130) reads `getCookie(c,'session')`. Cookies are named **`session`** (access) and **`refresh`**. `setSessionCookie`/`setRefreshCookie` helpers exist (114-115). Mirror the logout cookie-clear for deletion.
- `src/modules/auth/middleware.ts:29,55-56` — `requireAuth` reads `session` cookie, sets `c.get('user')` (UserWithRelations) + `c.get('session')`.
- `prisma/schema.prisma`: User (37-65) — relations subscription/sessions/portfolios/payments/snapshots; only pref-like column is `newsletterSubscribed`. Cascade map: Session.userId **Cascade** (85), Portfolio.userId **Cascade** (234), Subscription.userId **Cascade** (109), BalanceSnapshot.userId **Cascade** (433), Payment.userId **SetNull** (176). **Payment.subscriptionId (178) is required with no onDelete** → defaults to Restrict.

## 1. The cascade problem (account deletion) — read first [LOCKED design]

Deleting a `user` row cascades to Subscription (109). But `Payment.subscriptionId` is a **required** FK
(schema.prisma:178) with no `onDelete`, so deleting that Subscription is **Restricted** when payments
reference it → the whole delete fails. Payment history must survive (that's why `Payment.userId` is already
SetNull). So:

**Schema delta A — make payments survivable:** change `Payment.subscription` to optional + SetNull:
```prisma
subscription   Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)
subscriptionId Int?
```
Add a NOTE comment (same style as the existing Payment.userId NOTE, schema.prisma:169-175) explaining this
preserves payment rows for accounting after both the user and subscription are gone. Idowu owns the docx edit.
After delete, an orphaned payment keeps `stripePaymentIntentId/amount/currency/status/createdAt` with
`userId=null, subscriptionId=null`.

Payment creation (Stage 4 webhook) still always supplies `subscriptionId` — nullable in schema doesn't change
the write path; verify the webhook/payment-create code still compiles and passes its tests.

## 2. Schema delta B — preference columns [LOCKED]

Add to `User` (schema.prisma, near `newsletterSubscribed` line 48), each with a NOTE comment (spec extension):
```prisma
priceAlertsEnabled Boolean @default(true)
pushEnabled        Boolean @default(false)
baseCurrency       String  @default("USD") @db.VarChar(3)
```
One Prisma migration covers deltas A + B. Run against the Neon dev DB.

## 3. Endpoints

### 3.1 `DELETE /users/me` [LOCKED]
Controller in `users.controller.ts`, `requireAuth`:
- `const user = c.get('user')`.
- **If the user has an effectively-active Pro subscription, cancel it at Stripe first** so deletion doesn't leave a live paid subscription billing a deleted user. Reuse the subscriptions module's cancel/Stripe path via its service if cleanly callable; if not, **STOP and ask** (don't duplicate Stripe logic). For Free/no-sub users, skip.
- Delete the user: `await deleteUser(user.id)` (new repo fn: `prisma.user.delete({where:{id}})`). DB cascades handle sessions/portfolios/subscription/snapshots; delta A SetNulls payments.
- Clear cookies: `deleteCookie(c, 'session')` and `deleteCookie(c, 'refresh')` (mirror logout).
- Return `c.json(ok({ deleted: true }), 200)`.

### 3.2 `PATCH /users/preferences` [LOCKED]
New schema in `users.schemas.ts`:
```ts
export const PatchPreferencesSchema = z.object({
  newsletterSubscribed: z.boolean().optional(),
  priceAlertsEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  baseCurrency: z.enum(['USD','EUR','GBP','JPY','NGN']).optional(),
}).strict();
```
(The currency set matches the frontend settings selector.) Controller `PATCH /preferences`, `requireAuth`,
same safeParse→400 pattern as PATCH /me. Service `updatePreferences(user, body)` → repo update → returns
`{ user: toUserDTO(updated) }`. Extend `updateProfile` (or add `updatePreferences`) to accept the 3 new fields.

### 3.3 Surface the new fields on GET /users/me [LOCKED]
Extend `UserDTO` + `toUserDTO` (users.repository.ts) with `priceAlertsEnabled`, `pushEnabled`, `baseCurrency`
so the settings Preferences tab can hydrate its toggles. (`newsletterSubscribed` already present.)

## 4. Scope
```
prisma/schema.prisma                         # EDIT — delta A (Payment.subscriptionId?) + delta B (3 User cols) + NOTE comments
prisma/migrations/<new>                       # NEW — one migration for A+B
src/modules/users/users.schemas.ts           # EDIT — PatchPreferencesSchema
src/modules/users/users.repository.ts        # EDIT — deleteUser; extend UserDTO/toUserDTO/updateProfile
src/modules/users/users.service.ts           # EDIT — deleteMe, updatePreferences
src/modules/users/users.controller.ts        # EDIT — DELETE /me, PATCH /preferences
tests/users.test.ts                          # EDIT — new tests
```
No frontend changes here (Idowu aligns the frontend separately). No edits to other modules except the Stripe-cancel reuse in 3.1.

## 5. Tests (mirror tests/users.test.ts pattern; continue its numbering)
- `DELETE /users/me`: user + portfolios/sessions gone; a seeded succeeded Payment survives with `userId=null` AND `subscriptionId=null`; `session`/`refresh` cookies cleared (response Set-Cookie clears them); a follow-up `GET /users/me` with the old cookie → 401.
- `DELETE /users/me` with an active Pro sub → Stripe cancel invoked (mock Stripe), then user deleted.
- `PATCH /users/preferences`: each field updates; `.strict()` rejects unknown keys (400); invalid `baseCurrency` (400); `GET /users/me` reflects the new values.
- Confirm existing payment/subscription tests still pass after delta A (subscriptionId now nullable in the type).

## 6. STOP-and-ask gates
1. **Stripe cancel reuse (3.1):** if the subscriptions module's cancel/Stripe-cancel isn't cleanly callable as a service, STOP — don't duplicate Stripe code or skip the cancel silently.
2. **Cascade verification:** after the migration, prove (in a test) that `DELETE /users/me` for a user WITH payments succeeds and the payment row survives. If Restrict still bites (delta A not effective), STOP.
3. If making `Payment.subscriptionId` nullable breaks the payment-create/webhook type contracts beyond a trivial fix, surface it.

## 7. What NOT to do
- No frontend edits. No docx edits (add to doc-fix pile in the report). No `git add -A`. Leave stale `stage-14*.md` untracked.
- Don't soft-delete or anonymize-in-place — this is a hard delete with payment-row preservation via SetNull.
- Don't fold preferences into PATCH /users/me — the frontend calls a dedicated `/users/preferences` (keep PATCH /me as-is, including its existing `newsletterSubscribed`).

## 8. Commit and report
```bash
git add prisma/schema.prisma prisma/migrations \
        src/modules/users/users.schemas.ts \
        src/modules/users/users.repository.ts \
        src/modules/users/users.service.ts \
        src/modules/users/users.controller.ts \
        tests/users.test.ts \
        _claude/retrofit-5.md
git commit -m "feat(users): account deletion (DELETE /users/me) + notification preferences (PATCH /users/preferences)"
git log --oneline -3
```
Report: new SHA; demonstration that account deletion preserves payment history (null FKs) and clears cookies; preferences round-trip via GET /users/me; full suite count; and the **doc-fix items** (Payment.subscriptionId now nullable+SetNull; User gains priceAlertsEnabled/pushEnabled/baseCurrency; new DELETE /users/me + PATCH /users/preferences endpoints — none in the current docx). If blocked, output the question and STOP.
