# Neonfi backend — retrofit-6: Password reset (email users)

Commit 2 of 4 in the frontend-audit remediation (`_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `88f8a4b` (retrofit-5).

Builds the password-reset flow the settings page already triggers (settings/+page.svelte:81 → `POST /auth/password-reset`).
Deliberate spec extension — not in the architecture's auth endpoint set → goes on the docx-fix pile.

**No schema delta, no migration.** Reset tokens live in Redis exactly like email-verification tokens — do NOT add a DB table.

## 0. Pre-verified state — what I read (re-verify before editing)

- `src/modules/auth/auth.service.ts`: verification-token pattern to mirror — `makeVerificationToken()` (73-75) = `randomBytes(32).toString('hex')`; store `redis.set('email_verify:<token>', String(user.id), 'EX', 86400)` (114); single-use validate `redis.getdel('email_verify:<token>')` (217). Rate-limit pattern (`resendVerification`, 251-281): `redis.set('resend_verify:<email>', '1', 'EX', 60, 'NX')` → 429 if already set, set BEFORE the existence check so 429 leaks nothing. Dev-only URL log gated `if (!isProduction)` (119-121). `AuthError(status, code, message, meta?)` (48-58). Google-only users have `passwordHash === null` (157-161).
- `src/modules/auth/auth.schemas.ts:9-14` — `passwordSchema` (min8/max128/letter+number), currently module-private. `RegisterSchema` etc. lowercase email via `.transform`.
- `src/modules/auth/auth.controller.ts`: `validate(schema)` helper (57-69) returns `WEAK_PASSWORD` for password-path issues else `VALIDATION_ERROR`; `handleError(e,c)` (76-84) maps AuthError. Endpoint style: `router.post('/path', validate(Schema), handler)` (90-98). Router mounted at `/api/v1/auth`.
- `src/modules/email/email.service.ts`: `send({to,subject,html,text,template})` (15-68), fire-and-forget, never throws. Per-template exports like `sendVerificationEmail` (89-107). Add `sendPasswordResetEmail` in the same shape.
- `src/modules/users/users.repository.ts`: `findUserByEmail` (79-83, returns UserWithRelations incl. authProvider/onboardingStatus), `findUserById`. Has no `updatePassword`/bulk session-revoke yet. `revokeSession(id)` (142-147) revokes one; `findActiveSessionsByUser` (149-158).
- `src/lib/password.js` — `hashPassword`, `verifyPassword` (imported at auth.service.ts:20).
- `src/lib/config.js` — `APP_BASE_URL` (used for verification URLs).

## 1. Endpoints

### 1.1 `POST /auth/password-reset` — request a reset link [LOCKED]
Mirror `resendVerification` exactly:
- Rate-limit FIRST: `redis.set('reset_request:<email>', '1', 'EX', 60, 'NX')` → if not set, `429 TOO_MANY_REQUESTS` (uniform — set before existence check so it leaks nothing).
- `findUserByEmail(email)`. Only proceed if the user exists AND is an **email** account (`authProvider.name === 'email'` / `passwordHash !== null`). Otherwise return 200 silently (no token, no email — uniform, no enumeration; Google-only accounts can't reset a password).
- Fire-and-forget (`void (async () => {...})()` after the response path): generate token (`randomBytes(32).hex`), `redis.set('password_reset:<token>', String(user.id), 'EX', 3600)` (1h), `resetUrl = ${config.APP_BASE_URL}/reset-password?token=<token>`, dev-log it `if (!isProduction)`, `sendPasswordResetEmail({to, fullName, resetUrl})`.
- **Always** return `200 { ok: true }` (except the 429).

### 1.2 `POST /auth/password-reset/confirm` — set the new password [LOCKED]
- `redis.getdel('password_reset:<token>')` → null → `400 INVALID_RESET_TOKEN` (invalid or expired). Single-use.
- `findUserById(userId)`; if missing OR not an email account (`authProvider.name !== 'email'`) → `400 INVALID_RESET_TOKEN` (defensive — request only issues for email users).
- `hashPassword(body.password)` → `updatePassword(userId, hash)`.
- **Revoke all the user's sessions** (`revokeAllSessionsForUser(userId)`) so a reset locks out any attacker session. Don't auto-login; the frontend sends the user to login afterward.
- Return `200 { ok: true }`.

## 2. Schema (Zod) — `auth.schemas.ts`
```ts
export const PasswordResetRequestSchema = z.object({
  email: z.string().email('Invalid email address').transform((e) => e.toLowerCase()),
});
export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: passwordSchema, // reuse — gives WEAK_PASSWORD via validate()
});
export type PasswordResetRequestBody = z.infer<typeof PasswordResetRequestSchema>;
export type PasswordResetConfirmBody = z.infer<typeof PasswordResetConfirmSchema>;
```

## 3. Scope
```
src/modules/auth/auth.schemas.ts        # EDIT — 2 schemas + types
src/modules/auth/auth.service.ts        # EDIT — requestPasswordReset, confirmPasswordReset (+ token helper)
src/modules/auth/auth.controller.ts     # EDIT — POST /password-reset, POST /password-reset/confirm
src/modules/email/email.service.ts      # EDIT — sendPasswordResetEmail (template 'password_reset')
src/modules/users/users.repository.ts   # EDIT — updatePassword(userId, hash); revokeAllSessionsForUser(userId)
tests/auth.test.ts                      # EDIT — new tests
```
No schema.prisma change, no migration, no env var. No frontend (the `/reset-password` page is part of the separate frontend pass).

## 4. Tests (mirror tests/auth.test.ts; reuse its email mock — add sendPasswordResetEmail to it)
- Request, email user → 200; `password_reset:<token>` exists in Redis; `sendPasswordResetEmail` called (mock).
- Request, nonexistent email → 200; no token, email not called.
- Request, Google-only user → 200; no token (can't reset).
- Request twice within 60s → 2nd is 429.
- Confirm, valid token + strong password → 200; old password now fails login, new password succeeds; token is single-use (replay → 400); the user's prior sessions are revoked.
- Confirm, invalid/expired token → 400 INVALID_RESET_TOKEN.
- Confirm, weak password → 400 WEAK_PASSWORD.

## 5. STOP-and-ask gates
1. If `passwordSchema` can't be reused cleanly (it's module-private but same file — should be fine), export it rather than duplicating the policy.
2. If revoking all sessions needs a new repo query and `prisma.session.updateMany({where:{userId, revokedAt:null}, data:{revokedAt:new Date()}})` doesn't fit the repository's style, surface it — don't loop one-by-one silently if a bulk update is the norm.
3. If the email-test mock is structured so adding `sendPasswordResetEmail` breaks other auth tests, surface it.

## 6. What NOT to do
- No DB table / schema delta / migration for reset tokens — Redis only (mirror email_verify).
- Don't auto-login on confirm; don't return tokens/cookies from either endpoint.
- Don't let a reset set a password on a Google-only account.
- No docx edits (doc-fix pile in report). No `git add -A`. Leave stale `stage-14*.md` + `frontend-audit.md` untracked.

## 7. Commit and report
```bash
git add src/modules/auth/auth.schemas.ts src/modules/auth/auth.service.ts \
        src/modules/auth/auth.controller.ts src/modules/email/email.service.ts \
        src/modules/users/users.repository.ts tests/auth.test.ts \
        _claude/retrofit-6.md
git commit -m "feat(auth): password reset (POST /auth/password-reset + /password-reset/confirm)"
git log --oneline -3
```
Report: new SHA; demonstration of the full request→confirm→login-with-new-password cycle, single-use token, session revocation, and the uniform/rate-limited request behavior; full suite count (run per-file/Neon-retry); doc-fix item (new password-reset endpoints, not in docx). If blocked, output the question and STOP.
