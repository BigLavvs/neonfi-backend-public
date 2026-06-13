# Neonfi backend — Stage 3A: Subscription initial activation + read

This file is the source-of-truth intent for Stage 3A. Build from this; report back to Idowu when done. Stage 3B (upgrade/downgrade/cancel/refund + plan middleware activation) and Stage 4 (Stripe webhook handler) are separate prompts.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `5478a0f` (Stage 2 — users module).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` and `_claude/stage-2.md` (this repo) — patterns Stage 3A reuses (auth middleware, service/controller/repository split, toUserDTO, envelope helpers, Vitest cleanup approach).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **§Stage 3 in full**, **§4.1 onboarding flow** (the email/Pro path), **§4.2 onboarding flow** (the Google/Free path), **§2.3** (envelopes), **§2.6** (idempotency — relevant for the duplicate-activation case).
3. `Neonfi System Architecture.docx`:
   - `SUBSCRIPTION` entity — including the explicit note "POST /subscriptions is the initial activation endpoint called once during onboarding... Free plan activates immediately in the same request; Pro plan returns a Stripe checkout URL and activates on confirmed Stripe webhook."
   - `PAYMENT` entity — only relevant to understand which webhook will eventually create Payment rows (Stage 4); Stage 3A does NOT touch Payment.
   - `Plan-Based Access Control` rules — read for context but DO NOT enforce them here (Stage 3B activates the middleware).
4. `prisma/schema.prisma` — `Subscription`, `Plan`, `BillingCycle`, `SubscriptionStatus` models. Note `Subscription.userId @unique` — one subscription per user, enforced by the schema.
5. The frontend code that consumes these endpoints:
   - `src/routes/(dashboard)/payments/+page.ts` (and `+page.svelte`) — reads `GET /subscriptions/me`
   - `src/routes/(onboarding)/onboarding/+page.svelte` — calls `POST /subscriptions` during the onboarding wizard

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Free vs Pro flow — radically different paths [LOCKED by Build Guide §Stage 3]

**Free activation:** synchronous. Same-request. Creates the Subscription row, transitions `User.onboardingStatus` from `verified → plan_selected → complete` (two transitions, same DB transaction), sends a subscription-confirmation email asynchronously, returns the subscription DTO. **No Stripe involvement.**

**Pro activation:** asynchronous. Same-request returns ONLY a Stripe Checkout URL — no Subscription row is created yet, no onboarding transition happens yet. The user then completes Stripe Checkout (entering card details on Stripe's hosted page), Stripe sends a `checkout.session.completed` webhook (handled in Stage 4), and THAT webhook creates the Subscription row + Payment row + drives the onboarding transitions. Stage 3A's `POST /subscriptions { plan: 'pro' }` is purely a checkout-initiation endpoint.

**Why this matters for Stage 3A:** you must NOT create a Subscription row for Pro requests. The metadata you pass to Stripe (userId, plan, billingCycle) is what the Stage 4 webhook will use to create the row idempotently. If Stage 3A creates a row eagerly, Stage 4 will double-create it.

### 1.2 Onboarding state gating on POST /subscriptions

The user's `onboardingStatus.name` MUST be `verified` to call `POST /subscriptions`. Three cases:

- `pending_verification` → `403 EMAIL_NOT_VERIFIED`. Force email verification first.
- `verified` → proceed.
- `plan_selected` or `complete` → `409 SUBSCRIPTION_ALREADY_ACTIVATED`. The user has already done initial activation; subsequent changes go through `/subscriptions/upgrade` or `/subscriptions/downgrade` (Stage 3B).

This is a hard precondition. Surface the check at the top of the service function, before any other work.

### 1.3 Stripe SDK + singleton client

Install `stripe` as a runtime dep (~3MB, no native deps, official Stripe Node.js SDK). Create `src/lib/stripe.ts` as a singleton:

```ts
import Stripe from 'stripe';
import { config } from './config.js';

export const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
  // Pin the API version explicitly; Stripe's behavior is version-locked.
  apiVersion: '2024-12-18.acacia',  // or whatever the SDK's default is at install time — pin to whatever Stripe.LATEST_API_VERSION resolves to
  typescript: true,
});
```

**Singleton rule** (same as Prisma/Redis): no other file constructs `new Stripe(...)`. Update `scripts/check-singletons.mjs` to also fail if `new Stripe(` appears outside `src/lib/`.

Pin the `apiVersion`. Stripe's API is versioned per account; if you omit `apiVersion`, the SDK uses your account's default, which can change unexpectedly. Pin it once, change it deliberately.

### 1.4 Stripe Checkout Session config

For Pro activation, create a Stripe Checkout Session with:

```ts
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{
    price: billingCycle === 'monthly'
      ? config.STRIPE_PRO_MONTHLY_PRICE_ID
      : config.STRIPE_PRO_YEARLY_PRICE_ID,
    quantity: 1,
  }],
  customer_email: user.email,
  client_reference_id: String(user.id),  // human-readable backup for debugging
  metadata: {
    userId: String(user.id),
    plan: 'pro',
    billingCycle,  // 'monthly' | 'yearly'
  },
  success_url: `${config.APP_BASE_URL}/onboarding?subscription=activated`,
  cancel_url: `${config.APP_BASE_URL}/onboarding?subscription=cancelled`,
});

return { checkoutUrl: session.url };
```

**Critical:** every field of `metadata` MUST be a string (Stripe forces this). Cast `user.id` to `String`. The Stage 4 webhook reads `metadata.userId`, `metadata.plan`, `metadata.billingCycle` to drive the post-payment work.

`success_url` lands the user back on the onboarding wizard. The wizard reads the query string and shows the success state, then redirects to `/dashboard` once it confirms via `GET /users/me` that the user's `onboardingStatus === 'complete'`. Stage 4's webhook is what actually transitions to `complete` — the success_url just gives the user something to look at while the webhook is being processed.

### 1.5 Subscription DTO shape

Match the `SUBSCRIPTION` resource representation in `Neonfi System Architecture.docx`:

```ts
interface SubscriptionDTO {
  id: number;
  userId: number;
  plan: 'free' | 'pro';
  billingCycle: 'monthly' | 'yearly' | null;
  status: 'active' | 'cancelled' | 'expired';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- Lookup-table FKs (`planId`, `billingCycleId`, `statusId`) are resolved to their string names in the DTO. Never expose the IDs.
- `billingCycle` is null for free plans (one-time activation, no billing period).
- `stripeCustomerId` and `stripeSubscriptionId` are null until Stage 4's webhook fills them in (Pro path).
- `currentPeriodStart` and `currentPeriodEnd` are null for free plans and for Pro before the webhook arrives.

For free activation, set:
- `planId` → 'free' row
- `billingCycleId` → null
- `statusId` → 'active' row
- Stripe fields → null
- Period fields → null

### 1.6 Email module: add subscription-confirmation

Add `sendSubscriptionConfirmationEmail({ to, fullName, plan })` to `src/modules/email/email.service.ts`. Minimal HTML + text, fire-and-forget, same pattern as the welcome/verification senders. Called from the free-activation path; the Stage 4 webhook will call it for Pro after the webhook lands.

### 1.7 Test-isolation cleanup — mock the email module across all tests

The current `auth.test.ts` and `users.test.ts` make REAL Resend calls (fire-and-forget through the email service). This drains your Resend quota every test run. **As part of Stage 3A, retroactively mock the email module in all three test files.** At the top of each:

```ts
vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));
```

After this, all 50 existing tests must still pass, and no real Resend calls should occur during `npx vitest run`. Verify by checking that the test output no longer contains `[email] {"event":"email_sent",...}` log lines.

## 2. Module scope

```
src/modules/subscriptions/subscriptions.controller.ts     # NEW — mounts at /api/v1/subscriptions
src/modules/subscriptions/subscriptions.service.ts        # NEW
src/modules/subscriptions/subscriptions.schemas.ts        # NEW
src/modules/subscriptions/subscriptions.repository.ts     # NEW
src/modules/subscriptions/subscriptions.dto.ts            # NEW — toSubscriptionDTO()
src/modules/email/email.service.ts                        # EDIT — add sendSubscriptionConfirmationEmail
src/lib/stripe.ts                                         # NEW — singleton Stripe client
scripts/check-singletons.mjs                              # EDIT — guard against `new Stripe(`
src/app.ts                                                # EDIT — mount subscriptions router
src/modules/users/users.repository.ts                     # EDIT — add transitionToCompleteOnboarding() helper
tests/subscriptions.test.ts                               # NEW — ~12 tests
tests/auth.test.ts                                        # EDIT — add email module mock at top
tests/users.test.ts                                       # EDIT — add email module mock at top
```

Do NOT touch any other module directory. They keep their `.gitkeep`.

## 3. Endpoints

### 3.1 `POST /subscriptions` — initial activation (one-time, during onboarding)

**`requireAuth` middleware required.** Request body (Zod, `.strict()`):

```json
{
  "plan":         "free" | "pro",
  "billingCycle": "monthly" | "yearly"
}
```

- `billingCycle` is REQUIRED when `plan === 'pro'`, FORBIDDEN when `plan === 'free'`. Validate via Zod refine.

**Flow:**

1. Load the current user's `onboardingStatus.name`. (User is on context from middleware; status is already populated.)
2. **Gate check:**
   - `pending_verification` → `403 EMAIL_NOT_VERIFIED`.
   - `plan_selected` or `complete` → `409 SUBSCRIPTION_ALREADY_ACTIVATED`.
   - `verified` → proceed.
3. **If plan === 'free':**
   - Begin DB transaction.
   - Insert Subscription row: `planId` → 'free', `billingCycleId` → null, `statusId` → 'active', Stripe fields null, period fields null.
   - Update User: set `onboardingStatusId` to the 'complete' row. (Per Build Guide §Stage 1: `verified → plan_selected → complete` happens "immediately after plan confirmation, in the same request for free". We collapse to the final state.)
   - Commit.
   - After commit (background): send subscription-confirmation email.
   - Respond: `201 { data: { subscription: <SubscriptionDTO> } }`.
4. **If plan === 'pro':**
   - Do NOT touch the DB. No Subscription row created here. No onboarding transition here.
   - Create a Stripe Checkout Session per §1.4.
   - Respond: `200 { data: { checkoutUrl: <Stripe URL> } }`.
   - The Stage 4 webhook handler will create the Subscription row + transition onboarding when payment confirms.

### 3.2 `GET /subscriptions/me` — read own subscription

**`requireAuth` middleware required.**

**Flow:**
1. `prisma.subscription.findUnique({ where: { userId: user.id }, include: { plan, billingCycle, status } })`.
2. If null: `404 NOT_FOUND` with code `SUBSCRIPTION_NOT_FOUND`. (The frontend handles this gracefully — a verified user with no subscription is mid-onboarding.)
3. Map through `toSubscriptionDTO()`.
4. Respond: `200 { data: { subscription: <SubscriptionDTO> } }`.

## 4. Cross-cutting wiring

### 4.1 Stripe client singleton + guard

- `src/lib/stripe.ts` per §1.3.
- Update `scripts/check-singletons.mjs` to fail the build if `new Stripe(` appears outside `src/lib/`.
- The CI/build chain already runs the guard via `npm run build`; verify it still passes after the change.

### 4.2 Mount the subscriptions router

In `src/app.ts`, after the users router:

```ts
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.controller.js';
// ...
app.route('/api/v1/subscriptions', subscriptionsRouter);
```

### 4.3 Helper in users.repository.ts

Add a small helper `transitionToCompleteOnboarding(userId, prismaTx?)` that updates a user's `onboardingStatusId` to the 'complete' row. Take an optional Prisma transaction client so it can participate in the subscription-activation transaction. The user state-machine helpers are the users module's responsibility; subscriptions calls them.

DO NOT add helpers for the intermediate states (`plan_selected`) — the build guide collapses to `complete` in the same request for free, and Stage 4's webhook collapses similarly for Pro. We don't ever sit in `plan_selected`.

## 5. Tests (Vitest, integration — new file `tests/subscriptions.test.ts`)

Mock `stripe` at the top of `tests/subscriptions.test.ts` since real Stripe calls would create real test-mode sessions (consuming free-tier quota and polluting your Stripe dashboard):

```ts
const { mockCreateSession } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCreateSession } },
  }));
  return { default: Stripe };
});
```

Also mock the email module (same as §1.7).

**Test list (numbered continuing from Stage 2's 50):**

51. **POST /subscriptions { plan: 'free' } as verified user** → 201; Subscription row created with planId='free', billingCycleId=null, statusId='active'; User's onboardingStatus transitioned to 'complete'; DTO returned. Verify Stripe was NOT called.
52. **POST /subscriptions { plan: 'pro', billingCycle: 'monthly' } as verified user** → 200; `data.checkoutUrl` matches the mocked Stripe URL; mockCreateSession called with `mode: 'subscription'`, the monthly price ID, and metadata `{ userId, plan: 'pro', billingCycle: 'monthly' }`; **no Subscription row created**; onboardingStatus unchanged.
53. **POST /subscriptions { plan: 'pro', billingCycle: 'yearly' }** → mockCreateSession called with the yearly price ID and `billingCycle: 'yearly'` in metadata.
54. **POST /subscriptions { plan: 'free' } as pending_verification user** → 403 `EMAIL_NOT_VERIFIED`; no Subscription created; onboardingStatus unchanged.
55. **POST /subscriptions { plan: 'free' } when user already has a Subscription** → 409 `SUBSCRIPTION_ALREADY_ACTIVATED`; only one Subscription row.
56. **POST /subscriptions { plan: 'pro' } when user has onboardingStatus 'complete'** → 409 `SUBSCRIPTION_ALREADY_ACTIVATED`; Stripe NOT called.
57. **POST /subscriptions { plan: 'pro' } without billingCycle** → 400 `VALIDATION_ERROR`.
58. **POST /subscriptions { plan: 'free', billingCycle: 'monthly' }** → 400 `VALIDATION_ERROR` (billingCycle forbidden for free).
59. **POST /subscriptions invalid plan** → 400 `VALIDATION_ERROR`.
60. **POST /subscriptions unknown field in body** → 400 `VALIDATION_ERROR` (`.strict()`).
61. **POST /subscriptions without auth** → 401 `UNAUTHENTICATED`.
62. **GET /subscriptions/me when subscription exists** → 200 with DTO matching the row.
63. **GET /subscriptions/me when no subscription exists** → 404 `SUBSCRIPTION_NOT_FOUND`.
64. **GET /subscriptions/me without auth** → 401.

Total after Stage 3A: **64 tests** (50 prior + 14 new).

## 6. STOP-AND-ASK gates

1. **If installing `stripe` reports a peer-dep conflict or build error**, surface it. Don't try alternate libraries (e.g. `stripe-node`, third-party wrappers).
2. **If you find `STRIPE_PRO_MONTHLY_PRICE_ID` or `STRIPE_PRO_YEARLY_PRICE_ID` in `.env` is not actually a valid Stripe Price ID** (Stripe will fail on the first real-mode call, but in tests we mock so this won't show up until manual smoke-test), note in the report that Idowu should verify them. Don't validate via API call from the backend — that's a deploy-time concern.
3. **If `Subscription.userId @unique` constraint is missing from `schema.prisma`** for any reason (it should be there per the schema docx), STOP — that's a schema invariant Stage 3A relies on for "one subscription per user."
4. **If the existing 50 tests fail after adding the email-module mock**, STOP — the mock is interfering with something unexpected. Investigate before continuing.

## 7. What NOT to do

- **No webhook handling.** `POST /webhooks/stripe` is Stage 4. Stage 3A's Pro path stops at returning a checkout URL.
- **No `POST /subscriptions/upgrade` / `downgrade` / `cancel` / `refund`.** Stage 3B.
- **No `requirePlan` middleware activation.** It stays a no-op pass-through until Stage 3B.
- **No portfolio/asset/transaction/NFT/snapshot/analytics work.** Their stages.
- **No Payment table writes.** Stage 4's webhook handler owns Payment row creation.
- **No `stripeCustomerId` lookup or storage** in Stage 3A. Stripe Checkout creates the customer; Stage 4 captures the ID from the webhook event.
- **No Subscription row creation for Pro.** Period. The Pro path returns ONLY a checkout URL.
- **No intermediate onboarding state.** Free goes directly from `verified` to `complete`. Don't make a stop at `plan_selected` — the doc says it's collapsed for free.
- **No real Stripe API calls in tests.** Mock the `stripe` import.
- **No real Resend calls in any test file.** Mock the email module across all three test files (auth.test.ts, users.test.ts, subscriptions.test.ts).
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**
- **No editing `.env` from this prompt.** The STRIPE_* vars are already populated.
- **No exposing Stripe customer or subscription IDs anywhere except the SubscriptionDTO** (and even there, they're null until Stage 4 fills them in).

## 8. Commit and report

```bash
git add -A
git commit -m "feat(subscriptions): Stage 3A — POST /subscriptions (free immediate, Pro checkout init) + GET /subscriptions/me + email mock refactor"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation each endpoint surface behaves per spec (one happy path + one error path for each).
- Vitest output: all **64 tests passing** (50 existing + 14 new).
- Confirmation no real Resend calls fire during `npx vitest run` (check that `[email]` log lines are gone from test output).
- Where `toSubscriptionDTO()` lives.
- Whether `stripe` was added as a new runtime dep (yes/no — should be yes).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
