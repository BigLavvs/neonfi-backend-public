# retrofit-24: session survives external-redirect returns (SameSite=Lax) + Stripe returns via an allowlisted returnPath

Two separate user-facing bugs, both backend. (The webhook 401s are a THIRD, separate thing — a
`STRIPE_WEBHOOK_SECRET` mismatch with the `stripe listen` secret; env-only, NOT in this retrofit.)

---

## Part 1 — SameSite=Lax so the session survives Stripe/OAuth returns
`src/lib/cookies.ts` sets `session` + `refresh` with `sameSite: 'Strict'`. Strict cookies are
**withheld by the browser on the request following a cross-site top-level navigation** — i.e.
returning from Stripe Checkout or Google OAuth — so the app sees no session and dumps the user on
/register. Switch to **Lax** (what `oauth_state` already uses): sent on top-level GET navigations
(the return trip) but NOT on cross-site POST/subresources, so CSRF protection holds. Frontend and
API are same-site in every env (localhost↔localhost; neonfi.live↔api.neonfi.live), so normal XHR
is unaffected.

- `src/lib/cookies.ts` `BASE_OPTS`: `sameSite: 'Strict' as const` → `sameSite: 'Lax' as const`.
- Update the two header comments (lines 3, 6) "SameSite=Strict" → "SameSite=Lax", noting it's
  required so the session survives OAuth/Stripe redirect returns.
- Leave httpOnly, `secure: isProduction`, path, maxAge untouched.

---

## Part 2 — return to the page you paid FROM, via an allowlisted `returnPath`
There are two ways to buy Pro: during **onboarding** (must return to `/onboarding` to finish the
wizard) and from the **payments page** (return to `/payments`). A single hardcoded `success_url`
breaks one of them. So the checkout carries a `returnPath` — but **allowlist it**, never reflect a
raw URL into `success_url` (open-redirect/phishing risk).

1. **Schema** (`subscriptions.schemas.ts`): add to BOTH the create-subscription body schema and
   the upgrade body schema:
   ```ts
   returnPath: z.enum(['/onboarding', '/payments', '/dashboard']).optional(),
   ```
   (z.enum IS the allowlist — anything else 400s. Keep `.strict()` if present; returnPath is now a
   known field. For the `plan: 'free'` activate branch returnPath is simply ignored.)
2. **Service** (`subscriptions.service.ts`): thread it through:
   ```ts
   async function createProCheckoutSession(user, billingCycle, returnPath: string = '/dashboard') {
     // ...
     success_url: `${config.APP_BASE_URL}${returnPath}?subscription=activated`,
     cancel_url:  `${config.APP_BASE_URL}${returnPath}?subscription=cancelled`,
   }
   ```
   `activateSubscription` (pro branch) and `upgradeSubscription` pass `body.returnPath` (falls back
   to `/dashboard` when absent — still safe). Because `returnPath` is enum-validated upstream, no
   string sanitisation is needed here, but do NOT interpolate any user string that hasn't passed
   the enum.

Frontend already sends it: onboarding → `returnPath: '/onboarding'`, payments → `'/payments'`.

---

## Gates
- Existing tests that assert the old `/onboarding` success_url (≈ subscriptions #52/#53/#65) now
  send/expect the returnPath. Grep `tests/subscriptions.test.ts` for `success_url` /
  `onboarding?subscription` and update: pass `returnPath` in the request, assert the success_url
  contains it. Add one case: invalid `returnPath` (e.g. `https://evil.com`) → 400 VALIDATION_ERROR.
- `npx vitest run tests/subscriptions.test.ts tests/auth.test.ts` (DATABASE_URL_TEST set, dev
  server stopped) → green. (auth cookie tests check presence/HttpOnly, not SameSite.)

## Commit (explicit add, no -A)
```bash
git add src/lib/cookies.ts src/modules/subscriptions/subscriptions.service.ts \
        src/modules/subscriptions/subscriptions.schemas.ts tests/subscriptions.test.ts \
        _claude/retrofit-24.md
git commit -m "fix(auth): SameSite=Lax so session survives Stripe/OAuth returns; feat(subscriptions): allowlisted returnPath for checkout (retrofit-24)"
```
Report SHA + confirm auth + subscriptions suites pass.
