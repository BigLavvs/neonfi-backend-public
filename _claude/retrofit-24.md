# retrofit-24: session survives external-redirect returns (SameSite=Lax) + Stripe returns to /payments

Two separate user-facing bugs, both backend:

1. **Logged out after returning from Stripe.** `src/lib/cookies.ts` sets the `session` and `refresh`
   cookies with `sameSite: 'Strict'`. Strict cookies are **withheld by the browser on a request that
   follows a cross-site top-level navigation** — i.e. coming back from Stripe Checkout (or Google
   OAuth). So on return the app sees no session and dumps the user on /register. Switch to **Lax**
   (what `oauth_state` already uses): Lax is sent on top-level GET navigations (the return trip)
   while still NOT sent on cross-site POST/subresource requests, so CSRF protection is preserved.
   The API is same-site with the frontend in every env (localhost↔localhost; neonfi.live↔
   api.neonfi.live), so normal same-site XHR is unaffected.

   In `src/lib/cookies.ts`, `BASE_OPTS`: change `sameSite: 'Strict' as const` → `sameSite: 'Lax' as const`.
   Update the two header comments (lines 3, 6) from "SameSite=Strict" → "SameSite=Lax" with a note
   that Lax is required so the session survives OAuth/Stripe redirect returns. Leave httpOnly,
   `secure: isProduction`, path, maxAge untouched.

2. **Stripe returns to /onboarding, not the payments page.** In `src/modules/subscriptions/
   subscriptions.service.ts` `createProCheckoutSession`:
   - `success_url`: `${config.APP_BASE_URL}/onboarding?subscription=activated` → `${config.APP_BASE_URL}/payments?subscription=activated`
   - `cancel_url`:  `${config.APP_BASE_URL}/onboarding?subscription=cancelled` → `${config.APP_BASE_URL}/payments?subscription=cancelled`
   (After payment the webhook completes onboarding + flips the user to Pro, so landing on /payments
   is correct for both the onboarding-Pro and upgrade-Pro paths.)

## Not in scope (separate, already identified)
- The webhook 401s are a **`STRIPE_WEBHOOK_SECRET` mismatch** — it must equal the `whsec_…` that
  `stripe listen` prints (env change + restart), NOT a code change. Don't touch the verification.
- The async gap (user can land on /payments a beat before the webhook flips them to Pro) is a
  frontend polish (a "finalizing your upgrade…" state) — handled separately on the frontend.

## Gates
- Update any test asserting the old success_url path. Likely `tests/subscriptions.test.ts` (the
  pro-checkout cases, ~52/53/65) assert `success_url`/checkout contains `/onboarding` — change to
  `/payments`. Grep tests for `onboarding?subscription` and `success_url`.
- Run per-file (local DB): `npx vitest run tests/subscriptions.test.ts tests/auth.test.ts` → green
  (auth cookie tests check presence/HttpOnly, not SameSite, so Lax shouldn't break them — confirm).

## Commit (explicit add, no -A)
```bash
git add src/lib/cookies.ts src/modules/subscriptions/subscriptions.service.ts tests/subscriptions.test.ts _claude/retrofit-24.md
git commit -m "fix(auth): SameSite=Lax so session survives Stripe/OAuth returns; fix(subscriptions): checkout returns to /payments (retrofit-24)"
```
Report SHA + confirm the auth + subscriptions suites pass.
