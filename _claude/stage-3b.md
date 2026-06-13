# Neonfi backend — Stage 3B: Subscription state machine + plan middleware activation

This file is the source-of-truth intent for Stage 3B. Build from this; report back to Idowu when done. Refund (`POST /subscriptions/refund`) and the Stripe webhook are Stage 4 — NOT in scope here.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `74d2c3c` (Stage 3A — initial activation + Stripe SDK + email mock retrofit).

## 0. Read first

In this order:

1. `_claude/stage-3a.md` (this repo) — Stage 3B reuses everything 3A set up: Stripe singleton, subscriptions module skeleton, toSubscriptionDTO, onboarding-status helpers, email mock in tests, the Pro Stripe Checkout pattern. Re-skim its §1.4 (Stripe Checkout config) and §1.5 (DTO shape).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **§Stage 3 in full** again (esp. the explicit "upgrade is immediate, downgrade is deferred" note); **§2.3 PLAN_LIMIT_REACHED**; **§4.7 Cancellation / downgrade flow**.
3. `Neonfi System Architecture.docx` — **PLAN-BASED ACCESS CONTROL** section AND **Subscription Module** rules ("Plan transitions must only occur after verified Stripe webhook, never on client assertion" — this constrains how we model "immediate" upgrade for monthly→yearly).
4. `prisma/schema.prisma` — Subscription model (currently has no `scheduled*` columns; you'll add them per §1.1).
5. The frontend code that consumes these endpoints:
   - `src/routes/(dashboard)/payments/+page.svelte` and `+page.ts` — calls `POST /subscriptions/cancel`, `POST /subscriptions/refund`. Read these to confirm the body shapes the frontend sends.
   - `src/lib/components/modals/RefundConfirmModal.svelte` if it exists — refund flow UX (note: refund itself is Stage 4, but the modal's body shape matters there).

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Schema delta — `scheduledPlanId` + `scheduledBillingCycleId` on Subscription [LOCKED]

The `Subscription` schema has no way to represent "this user has requested a downgrade that takes effect at period end." The architecture docx's resource rep also has no field for it. We add two new nullable FK columns to `Subscription`:

```prisma
model Subscription {
  // ... existing fields unchanged ...

  // NEW: when set, indicates a pending change that takes effect at currentPeriodEnd.
  // Used for deferred downgrades (Build Guide §Stage 3: "downgrade takes effect at end
  // of current billing period, not immediately"). Both null when no change is scheduled.
  // Cleared by the Stripe webhook (Stage 4) when the period actually ends.
  scheduledPlan          Plan?         @relation("ScheduledPlan", fields: [scheduledPlanId], references: [id])
  scheduledPlanId        Int?
  scheduledBillingCycle  BillingCycle? @relation("ScheduledBillingCycle", fields: [scheduledBillingCycleId], references: [id])
  scheduledBillingCycleId Int?

  // ... existing @@map etc ...
  @@index([scheduledPlanId])
  @@index([scheduledBillingCycleId])
}

// Add back-relations on Plan and BillingCycle:
model Plan {
  // ... existing ...
  scheduledSubscriptions Subscription[] @relation("ScheduledPlan")
}

model BillingCycle {
  // ... existing ...
  scheduledSubscriptions Subscription[] @relation("ScheduledBillingCycle")
}
```

Apply via the same pattern Stage 1A used for `Session.refreshTokenHash`: hand-write the SQL migration (Neon's shadow-DB doesn't support Prisma's diff), run via `prisma db execute`, mark resolved via `prisma migrate resolve --applied`. Migration name: `subscription_scheduled_change`.

Migration SQL:
```sql
ALTER TABLE "subscription" ADD COLUMN "scheduledPlanId" INTEGER REFERENCES "plan"(id);
ALTER TABLE "subscription" ADD COLUMN "scheduledBillingCycleId" INTEGER REFERENCES "billing_cycle"(id);
CREATE INDEX "subscription_scheduledPlanId_idx" ON "subscription"("scheduledPlanId");
CREATE INDEX "subscription_scheduledBillingCycleId_idx" ON "subscription"("scheduledBillingCycleId");
```

Update `toSubscriptionDTO()` to resolve and expose:
- `scheduledPlan: 'free' | 'pro' | null`
- `scheduledBillingCycle: 'monthly' | 'yearly' | null`

This is another doc-fix item: add both columns to the schema docx Subscription model AND both string fields to the architecture docx Subscription resource rep. Surface in the commit message.

### 1.2 Status semantics — `cancelled` means "ends at currentPeriodEnd, still active until then"

`SubscriptionStatus` has three values: `active | cancelled | expired`. Stage 3B uses them like this:

- `active` — normally functioning subscription. Free or Pro, currently in a billing period.
- `cancelled` — user has clicked Cancel. The subscription continues to function (return Pro features, etc.) until `currentPeriodEnd`, after which Stage 4's webhook flips status to `expired`. The frontend reads `currentPeriodEnd` to display "Pro until Dec 15, then Free."
- `expired` — past `currentPeriodEnd`. Pro features no longer available. Portfolios beyond Free's limit become inaccessible (not deleted — Build Guide §4.7).

The plan-based access middleware (§1.5) MUST treat `(status === 'active') || (status === 'cancelled' && currentPeriodEnd > now)` as effectively active. A cancelled-but-still-in-period subscription is fully Pro.

### 1.3 Upgrade paths (Build Guide: "takes effect immediately")

Three sub-cases, three Stripe interactions:

1. **Currently Free → request Pro (monthly OR yearly):** identical to Stage 3A's POST /subscriptions pro path. Create a Stripe Checkout Session, return `{ checkoutUrl }`. The Stage 4 webhook will UPDATE the existing Subscription row (planId='pro', billingCycleId set, statusId='active', stripeCustomerId/SubscriptionId/period dates set). **Refactor opportunity:** the Stripe Checkout call from 3A and from upgrade are the same. Lift into a helper `createProCheckoutSession(user, billingCycle): Promise<string>` in `subscriptions.service.ts`. Both call sites use it.

2. **Currently Pro monthly → request Pro yearly:** call `stripe.subscriptions.update(stripeSubscriptionId, { items: [{ id: <item_id>, price: STRIPE_PRO_YEARLY_PRICE_ID }], proration_behavior: 'create_prorations' })`. Stripe returns the updated subscription synchronously. Update the local Subscription row with the new `billingCycleId` and new `currentPeriodEnd` from Stripe's response. Status stays `active`. Send a confirmation email async ("Your plan was upgraded to Pro Yearly").

   **The subscription item ID is required.** Fetch the Stripe Subscription first to get the line-item ID: `const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId); const itemId = stripeSub.items.data[0].id;`. Then pass it in the update.

3. **Currently Pro yearly → request Pro yearly:** 400 `NO_CHANGE_TO_APPLY`.
4. **Currently Pro yearly → request Pro monthly:** 400 `INVALID_UPGRADE`. Tell the user to use `/downgrade`.
5. **No subscription:** 409 `NO_SUBSCRIPTION_TO_UPGRADE`. Tell the user to use `POST /subscriptions` for initial activation.
6. **Active scheduled downgrade or cancellation:** clear it. An upgrade overrides any pending downgrade/cancellation. Stripe-side: if `cancel_at_period_end` is true, call `stripe.subscriptions.update(id, { cancel_at_period_end: false })` first to reactivate. DB-side: clear `scheduledPlanId`/`scheduledBillingCycleId` to null, set `status = 'active'`. Then process the upgrade.

The "takes effect immediately" guarantee per the Build Guide is satisfied: free→pro completes when the webhook fires (Stripe Checkout flow, typically seconds), monthly→yearly completes synchronously via `stripe.subscriptions.update`.

### 1.4 Downgrade paths (Build Guide: "takes effect at end of current billing period")

Two sub-cases:

1. **Currently Pro (any billingCycle) → request Free:**
   - Stripe-side: `stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true })`.
   - DB-side: set `scheduledPlanId` → 'free' row, `scheduledBillingCycleId` → null. Leave `status = 'active'` and `planId` unchanged. The user remains Pro until `currentPeriodEnd`.
   - When Stage 4's webhook receives `customer.subscription.deleted` at period end, it updates the Subscription: `planId` → 'free', `billingCycleId` → null, `stripeSubscriptionId` → null (subscription is gone Stripe-side), `currentPeriodStart`/`End` → null, `scheduledPlanId` → null, `scheduledBillingCycleId` → null, `status` → `active`. The user transitions to Free without losing their account.
   - Send a downgrade-confirmation email async.

2. **Currently Pro yearly → request Pro monthly:** use Stripe Subscription Schedule:
   - Create a Subscription Schedule that switches to monthly at the period end:
     ```ts
     const schedule = await stripe.subscriptionSchedules.create({
       from_subscription: stripeSubscriptionId,
     });
     await stripe.subscriptionSchedules.update(schedule.id, {
       phases: [
         // Current phase (yearly) — keep as-is until period end
         { items: [{ price: STRIPE_PRO_YEARLY_PRICE_ID, quantity: 1 }], end_date: stripeSub.current_period_end },
         // Next phase (monthly) — starts at period end
         { items: [{ price: STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 }] },
       ],
     });
     ```
   - DB-side: set `scheduledBillingCycleId` → 'monthly' row. Leave `scheduledPlanId` null (plan stays Pro). `status = 'active'`.
   - Stage 4's webhook applies the change when the schedule phase transitions fire.

3. **Currently Free:** 400 `CANNOT_DOWNGRADE_FROM_FREE`. Free is the floor.
4. **No subscription:** 409 `NO_SUBSCRIPTION_TO_DOWNGRADE`.
5. **Downgrade requested while a downgrade is already scheduled:** 409 `DOWNGRADE_ALREADY_SCHEDULED`. The user must cancel the pending change before scheduling a new one (or upgrade to clear it).

Request body for `POST /subscriptions/downgrade`:
```json
{ "plan": "free" }
```
OR
```json
{ "billingCycle": "monthly" }
```

Use Zod refine: exactly one of `plan` or `billingCycle` must be present. Both → 400. Neither → 400.

### 1.5 Cancellation path

`POST /subscriptions/cancel`. No body.

- **Active Pro:** call `stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true })`. Set `status` → 'cancelled' immediately. `currentPeriodEnd` stays as-is. Send cancellation-confirmation email async.
- **Already cancelled Pro:** 200, idempotent — return current state without re-calling Stripe.
- **Free:** 400 `CANNOT_CANCEL_FREE`. Free isn't a paid subscription; it has nothing to cancel. Suggest delete-account flow (which is itself out of scope — doc-fix item).
- **No subscription:** 409 `NO_SUBSCRIPTION_TO_CANCEL`.

### 1.6 Plan middleware activation

The `requirePlan(allowed)` middleware in `src/modules/auth/plan.ts` is currently a no-op pass-through. Activate it:

```ts
export const requirePlan = (allowed: Array<'free' | 'pro'>) => async (c, next) => {
  const user = c.get('user');
  // Load the subscription (one query). Don't load it in requireAuth to avoid
  // paying the cost on every authenticated route — only plan-gated routes need it.
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    include: { plan: true, status: true },
  });

  if (!subscription) {
    return c.json(err('SUBSCRIPTION_REQUIRED', 'Activate a subscription to access this resource'), 403);
  }

  const now = new Date();
  const effectivelyActive =
    subscription.status.name === 'active' ||
    (subscription.status.name === 'cancelled' && subscription.currentPeriodEnd && subscription.currentPeriodEnd > now);

  if (!effectivelyActive) {
    return c.json(err('SUBSCRIPTION_EXPIRED', 'Subscription is no longer active'), 403);
  }

  const userPlan = subscription.plan.name as 'free' | 'pro';
  if (!allowed.includes(userPlan)) {
    return c.json(err('PLAN_LIMIT_REACHED', `This resource requires one of: ${allowed.join(', ')}`), 403);
  }

  // Attach for downstream handlers that need to know which plan the user is on.
  c.set('subscription', subscription);
  await next();
};
```

The `c.set('subscription', subscription)` extension means `AuthEnv` (the Hono type) needs the new context key. Update accordingly.

**Stage 3B does not USE requirePlan anywhere** — no Pro-only endpoints exist yet. Activating the middleware now means later stages (5, 6, 9, 12, 13, 14) can just import + apply it without a separate "activate plan middleware" task each time. **Verify it works** by writing a small unit-style test that constructs a mock context with various subscription states and asserts the right response code.

### 1.7 `toUserDTO` populates `plan` and `billingCycle` from Subscription

`GET /users/me` currently returns `plan: null, billingCycle: null` (Stage 2). With Subscription wiring in place, populate them:

```ts
// In users.repository.ts toUserDTO:
const subscription = await prisma.subscription.findUnique({
  where: { userId: user.id },
  include: { plan: true, billingCycle: true, status: true },
});

const effectivelyActive = subscription && (
  subscription.status.name === 'active' ||
  (subscription.status.name === 'cancelled' && subscription.currentPeriodEnd && subscription.currentPeriodEnd > new Date())
);

return {
  // ... existing fields ...
  plan: effectivelyActive ? subscription.plan.name as 'free' | 'pro' : null,
  billingCycle: effectivelyActive ? (subscription.billingCycle?.name as 'monthly' | 'yearly' ?? null) : null,
};
```

Two paths: either `toUserDTO` does the subscription query itself (simpler, but adds a query per call), or callers pre-fetch and pass the subscription in (faster, but every caller has to remember). For Stage 3B, go with the first option — one query per `/users/me` call is acceptable for MVP. Optimize later.

Stage 2's users tests assert `plan: null` for a verified-but-not-activated user. Those tests stay correct: a user with no Subscription row still gets `plan: null`. Tests that create a Subscription (the ones we're adding in Stage 3B) will see populated `plan`/`billingCycle`.

### 1.8 Refund stays in Stage 4

`POST /subscriptions/refund` is documented in the architecture as a Stage 3 endpoint, but it requires a Payment row to refund — and Payment rows only exist after Stage 4's Stripe webhook handler creates them. Building refund in 3B would require seeding fake Payment rows in tests AND would diverge from the real flow.

**Defer refund to Stage 4.** Stage 4 owns the Stripe webhook AND owns the refund endpoint, because both touch Payment.

## 2. Module scope

```
src/modules/subscriptions/subscriptions.controller.ts     # EDIT — add 3 routes
src/modules/subscriptions/subscriptions.service.ts        # EDIT — add upgrade/downgrade/cancel + lift Stripe checkout helper
src/modules/subscriptions/subscriptions.schemas.ts        # EDIT — UpgradeSchema, DowngradeSchema
src/modules/subscriptions/subscriptions.repository.ts     # EDIT — add helpers for scheduled-state writes
src/modules/subscriptions/subscriptions.dto.ts            # EDIT — add scheduledPlan, scheduledBillingCycle to DTO
src/modules/users/users.repository.ts                     # EDIT — toUserDTO populates plan/billingCycle from subscription
src/modules/auth/plan.ts                                  # EDIT — activate requirePlan middleware
src/modules/auth/middleware.ts                            # EDIT — add 'subscription' to AuthEnv context types
src/modules/email/email.service.ts                        # EDIT — add sendUpgradeEmail, sendDowngradeScheduledEmail, sendCancellationScheduledEmail
prisma/schema.prisma                                      # EDIT — Subscription scheduled* + Plan/BillingCycle back-relations
prisma/migrations/<ts>_subscription_scheduled_change/migration.sql  # NEW — hand-written, applied via prisma db execute
tests/subscriptions.test.ts                               # EDIT — add ~13 new tests (65–77 numbering)
tests/users.test.ts                                       # EDIT — add 2 tests for plan/billingCycle population in /users/me
tests/auth.test.ts                                        # NO EDIT — unchanged
tests/plan-middleware.test.ts                             # NEW — unit-style tests for requirePlan
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `POST /subscriptions/upgrade`

**`requireAuth` middleware required.** Body (Zod, `.strict()`):
```json
{ "billingCycle": "monthly" | "yearly" }
```

Both are valid. The service decides which Stripe interaction to use based on current state.

**Flow:**
1. Load user's subscription (with plan, billingCycle, status). If none: `409 NO_SUBSCRIPTION_TO_UPGRADE`.
2. If status is `expired`: `409 SUBSCRIPTION_EXPIRED` — they need to activate fresh via POST /subscriptions.
3. **If currentPlan === 'free':** call `createProCheckoutSession(user, billingCycle)` (the helper lifted from Stage 3A). Return `{ checkoutUrl }`. Status code 200.
4. **If currentPlan === 'pro' AND currentBillingCycle === 'monthly' AND requestedBillingCycle === 'yearly':** the immediate-update path (§1.3 case 2). Retrieve Stripe Sub, modify item to yearly price, update DB row from Stripe's response, clear any `scheduled*` fields and `cancel_at_period_end` if set, return updated SubscriptionDTO. Status code 200. Send upgrade-confirmation email async.
5. **If currentPlan === 'pro' AND currentBillingCycle === 'yearly' AND requestedBillingCycle === 'monthly':** `400 INVALID_UPGRADE` — direct user to `/downgrade`.
6. **If currentPlan === 'pro' AND requestedBillingCycle === currentBillingCycle:** `400 NO_CHANGE_TO_APPLY`. But: if `cancel_at_period_end` was true or `scheduledPlanId`/`scheduledBillingCycleId` were set, treat this as "reactivate" — clear those flags, call `stripe.subscriptions.update(id, { cancel_at_period_end: false })`, set status='active', return 200 with the DTO.

### 3.2 `POST /subscriptions/downgrade`

**`requireAuth` middleware required.** Body (Zod, refine: exactly one of plan or billingCycle):
```json
{ "plan": "free" }
```
OR
```json
{ "billingCycle": "monthly" }
```

**Flow:**
1. Load user's subscription. If none: `409 NO_SUBSCRIPTION_TO_DOWNGRADE`.
2. If status is `expired`: `409 SUBSCRIPTION_EXPIRED`.
3. If `scheduledPlanId` OR `scheduledBillingCycleId` already set: `409 DOWNGRADE_ALREADY_SCHEDULED`.
4. **If body has `plan: 'free'`:**
   - If currentPlan === 'free': `400 CANNOT_DOWNGRADE_FROM_FREE`.
   - Else: call `stripe.subscriptions.update(id, { cancel_at_period_end: true })`. Set `scheduledPlanId` → 'free' row, `scheduledBillingCycleId` → null. Return 200 with DTO. Send downgrade-scheduled email async.
5. **If body has `billingCycle: 'monthly'`:**
   - If currentPlan === 'free': `400 CANNOT_DOWNGRADE_FROM_FREE`.
   - If currentBillingCycle === 'monthly': `400 NO_CHANGE_TO_APPLY`.
   - Else (currentBillingCycle === 'yearly'): create a Stripe Subscription Schedule per §1.4 case 2. Set `scheduledBillingCycleId` → 'monthly' row. Return 200 with DTO. Send downgrade-scheduled email async.

### 3.3 `POST /subscriptions/cancel`

**`requireAuth` middleware required.** No body (or empty `{}` is fine).

**Flow:**
1. Load user's subscription. If none: `409 NO_SUBSCRIPTION_TO_CANCEL`.
2. If currentPlan === 'free': `400 CANNOT_CANCEL_FREE`.
3. If status === 'expired': `409 SUBSCRIPTION_EXPIRED`.
4. If status === 'cancelled' (already cancelled): respond 200 with current DTO (idempotent — Stripe call NOT repeated).
5. Else: call `stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true })`. Set local `status` → 'cancelled'. Respond 200 with DTO. Send cancellation-scheduled email async.

## 4. Cross-cutting wiring

### 4.1 Schema migration (Neon pattern, same as Stage 1A)

1. Edit `prisma/schema.prisma` to add the scheduled fields + back-relations per §1.1.
2. Create the migration directory `prisma/migrations/<timestamp>_subscription_scheduled_change/` with `migration.sql` containing the SQL from §1.1.
3. Apply via `prisma db execute --file prisma/migrations/<timestamp>_subscription_scheduled_change/migration.sql --url $env:DIRECT_URL` (or equivalent).
4. Mark resolved: `npx prisma migrate resolve --applied <timestamp>_subscription_scheduled_change`.
5. Regenerate the Prisma client: `npx prisma generate`.
6. Verify `Subscription` type now has `scheduledPlanId`/`scheduledBillingCycleId` available.

### 4.2 Email module additions

Add to `src/modules/email/email.service.ts`:
- `sendUpgradeEmail({ to, fullName, newPlan, newBillingCycle })`
- `sendDowngradeScheduledEmail({ to, fullName, scheduledPlan, scheduledBillingCycle, effectiveDate })`
- `sendCancellationScheduledEmail({ to, fullName, effectiveDate })`

All fire-and-forget, same pattern as the existing senders. Add them to the test mocks (auth.test.ts, users.test.ts, subscriptions.test.ts).

### 4.3 `AuthEnv` type extension

The middleware sets `c.set('subscription', ...)` when requirePlan succeeds. Update `AuthEnv` in `src/modules/auth/middleware.ts`:

```ts
export type AuthEnv = {
  Variables: {
    user: UserWithRelations;
    session: Session;
    subscription?: SubscriptionWithRelations;  // NEW — set by requirePlan, not requireAuth
  };
};
```

### 4.4 Stripe API mocks in tests

In `tests/subscriptions.test.ts`, extend the existing Stripe mock to cover the new methods:
```ts
const { mockCreateSession, mockSubscriptionsUpdate, mockSubscriptionsRetrieve, mockSubscriptionSchedulesCreate, mockSubscriptionSchedulesUpdate } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSubscriptionsUpdate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionSchedulesCreate: vi.fn(),
  mockSubscriptionSchedulesUpdate: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCreateSession } },
    subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
    subscriptionSchedules: { create: mockSubscriptionSchedulesCreate, update: mockSubscriptionSchedulesUpdate },
  }));
  return { default: Stripe };
});
```

## 5. Tests (Vitest, integration)

**Test numbering continues from Stage 3A's 64:**

### 5.1 `tests/subscriptions.test.ts` (~13 new tests)

65. **upgrade free → pro monthly** → 200 with checkoutUrl; mockCreateSession called with monthly price; no DB write (Subscription unchanged on this call).
66. **upgrade pro monthly → pro yearly** → 200; mockSubscriptionsRetrieve + mockSubscriptionsUpdate called; DB row's billingCycleId updated to 'yearly'; currentPeriodEnd updated from mock; status='active'.
67. **upgrade pro yearly → pro monthly** → 400 `INVALID_UPGRADE`.
68. **upgrade pro yearly → pro yearly (no-op)** → 400 `NO_CHANGE_TO_APPLY`.
69. **upgrade pro yearly with cancellation pending → pro yearly** → 200; cancel_at_period_end flipped to false; status reverts to 'active'; SubscriptionDTO returned.
70. **upgrade with no subscription** → 409 `NO_SUBSCRIPTION_TO_UPGRADE`.
71. **downgrade pro monthly → free** → 200; mockSubscriptionsUpdate called with cancel_at_period_end=true; DB row's scheduledPlanId set to 'free' row; status stays 'active'.
72. **downgrade pro yearly → monthly** → 200; mockSubscriptionSchedulesCreate + mockSubscriptionSchedulesUpdate called; DB row's scheduledBillingCycleId set to 'monthly' row; plan/billingCycle on the row unchanged.
73. **downgrade from free** → 400 `CANNOT_DOWNGRADE_FROM_FREE`.
74. **downgrade with no subscription** → 409 `NO_SUBSCRIPTION_TO_DOWNGRADE`.
75. **downgrade with scheduled change already pending** → 409 `DOWNGRADE_ALREADY_SCHEDULED`.
76. **cancel active pro** → 200; mockSubscriptionsUpdate called with cancel_at_period_end=true; DB row's status set to 'cancelled'; currentPeriodEnd unchanged.
77. **cancel already-cancelled pro (idempotent)** → 200 without calling Stripe again (assert mockSubscriptionsUpdate NOT called).
78. **cancel free** → 400 `CANNOT_CANCEL_FREE`.

### 5.2 `tests/users.test.ts` (~2 new tests, renumber as 51–52)

51. **GET /users/me when user has active Pro subscription** → DTO has `plan: 'pro'`, `billingCycle: 'monthly'` (or whatever was activated).
52. **GET /users/me when user has cancelled Pro subscription with currentPeriodEnd in the future** → DTO still has `plan: 'pro'` (effectively active per §1.2).

### 5.3 `tests/plan-middleware.test.ts` (NEW, ~5 tests)

Unit-style tests for `requirePlan`. Construct a Hono test app with one route using the middleware:

```ts
const testApp = new Hono<AuthEnv>();
testApp.get('/pro-only', requirePlan(['pro']), (c) => c.json({ ok: true }));
testApp.get('/free-or-pro', requirePlan(['free', 'pro']), (c) => c.json({ ok: true }));
```

53. user with no subscription hits a plan-gated route → 403 `SUBSCRIPTION_REQUIRED`.
54. user with expired subscription → 403 `SUBSCRIPTION_EXPIRED`.
55. user with active free subscription on `/pro-only` → 403 `PLAN_LIMIT_REACHED`.
56. user with active pro subscription on `/pro-only` → 200.
57. user with cancelled-but-in-period pro subscription on `/pro-only` → 200 (cancelled counts as active until period end).

**Total tests after Stage 3B: 77+5+2 = 84 minus duplicates. Recount:**
- Auth (1–34): 34
- Users (35–50 + 51–52): 18
- Subscriptions (51–64 + 65–78): 28
- Plan middleware (53–57): 5

Wait — the user-tests "51" and the plan-middleware-tests "53" would collide. Re-number cleanly per the FILE the test lives in; just keep total counts honest. The bridging prompt asks for total test count, so:

- auth.test.ts: 34
- users.test.ts: 18 (16 prior + 2 new)
- subscriptions.test.ts: 28 (14 prior + 14 new)
- plan-middleware.test.ts: 5

**Total: 85 tests** after Stage 3B.

(If 65–78 is 14 new in subscriptions, total subscriptions = 14 + 14 = 28. Confirmed.)

## 6. STOP-AND-ASK gates

1. **Before the migration:** confirm the schema delta with Idowu — adding two new columns to `Subscription` (scheduledPlanId, scheduledBillingCycleId) is the right shape. (He has approved similar deltas three times already; this is a heads-up, not a blocker.)
2. **If the existing 64 tests fail after activating `requirePlan`:** STOP. The middleware activation should be invisible to tests that don't use plan-gated routes (none in Stage 1A/1B/2/3A do). If anything breaks, investigate before continuing.
3. **If `toUserDTO`'s extra subscription query causes more than 50% of users tests to slow down noticeably (or any to fail with timeouts):** consider whether to inline the subscription on the User context in `requireAuth` instead. Surface to Idowu before changing the global pattern.
4. **If Stripe Subscription Schedule's API has changed in the pinned `2026-05-27.dahlia` version such that the example in §1.4 doesn't work:** STOP and report. Don't guess the new shape.

## 7. What NOT to do

- **No refund endpoint.** Stage 4.
- **No Stripe webhook.** Stage 4.
- **No Payment table writes or reads.** Stage 4 owns Payment.
- **No new Stripe customers.** Stage 3A's Pro flow creates customers via Checkout. Upgrade from Free reuses that flow. Don't `stripe.customers.create` anywhere here.
- **No new envelope helpers.** Use `ok`/`err`.
- **No third-party plan-management library.** Hand-roll using stripe SDK + Prisma.
- **No real Stripe API calls in tests.** Mock per §4.4.
- **No real Resend calls.** Existing email mocks cover the new senders too (update the mock files).
- **No changing the schema's id-strategy.** Int autoincrement only.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**
- **No editing `.env`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(subscriptions): Stage 3B — upgrade/downgrade/cancel + scheduled-change schema delta + plan middleware activation"
git log --oneline -5
```

Report:
- New commit SHA.
- One happy path + one error path curl per endpoint (curls can use the dev server with a verified user + activated Pro).
- Vitest output: all **85 tests passing** (34 auth + 18 users + 28 subscriptions + 5 plan-middleware).
- Confirmation `prisma migrate` shows the new migration is applied.
- Schema delta applied (the two new Subscription columns).
- Whether any new runtime deps were added (should be none).
- Doc-fix pile items added in Stage 3B:
  - `Neonfi Database Schema.docx` Subscription: add `scheduledPlan` and `scheduledBillingCycle` FK relations.
  - `Neonfi System Architecture.docx` Subscription resource rep: add `scheduledPlan: "free" | "pro" | null` and `scheduledBillingCycle: "monthly" | "yearly" | null`.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
