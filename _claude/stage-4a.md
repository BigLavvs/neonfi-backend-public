# Neonfi backend — Stage 4A: Stripe webhook handler

This file is the source-of-truth intent for Stage 4A. Build from this; report back to Idowu when done. Payments read endpoints + refund are Stage 4B (separate prompt).

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `0a8ab8f` (Stage 3B — subscription state machine + plan middleware).

## 0. Read first

In this order:

1. `_claude/stage-3a.md` and `_claude/stage-3b.md` (this repo). Stage 4A is the consumer of every Stripe interaction those stages initiated — `checkout.session.completed` arrives for Stage 3A's Pro activation AND for Stage 3B's free→pro upgrade. `customer.subscription.deleted` arrives at period end to apply Stage 3B's deferred downgrades. Re-read the Stripe interaction summaries.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 4 in §3 in full** (including the Stripe webhook pseudocode), **§2.6 Idempotency Rules**, **§2.8 Webhooks**, **§4.1 Onboarding (email, Pro)** (the Stripe webhook is the actor that transitions `verified → plan_selected → complete` for Pro users — read step 5 of that flow carefully).
3. `Neonfi System Architecture.docx` — **PAYMENT WEBHOOK** entity, **Payment Webhook Module** rules, **Webhook Conventions**, **Idempotency Rules**.
4. `prisma/schema.prisma` — `Payment`, `PaymentStatus`. The schema already has every column you need for Stage 4A (no delta required). Confirm `Payment.stripePaymentIntentId @unique` — that constraint is your secondary idempotency safety net.
5. The Stripe SDK docs for `stripe.webhooks.constructEvent` (cached locally if the LLM environment can reach docs; otherwise the SDK's TS declarations are the contract).

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Signature verification — raw body, not parsed [LOCKED]

Stripe signs the EXACT raw body bytes. Any re-serialization (JSON.parse + JSON.stringify) changes whitespace and breaks the signature. The route handler MUST read the raw text BEFORE calling any JSON parser. In Hono:

```ts
router.post('/stripe', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature') ?? '';
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return c.json(err('INVALID_SIGNATURE', 'Webhook signature verification failed'), 401);
  }
  // ... idempotency check + dispatch
});
```

DO NOT add JSON body parsing middleware before this handler. DO NOT call `c.req.json()` on the request — that consumes the body stream and changes it.

If signature verification fails: return `401 INVALID_SIGNATURE` with no body processing. Don't log the raw signature value (sensitive).

### 1.2 Idempotency — Redis SET after successful processing

Stripe will retry events on any non-2xx response. Same event ID may arrive multiple times even without errors (Stripe-side retries, network glitches). Build the handler so that processing the same event twice produces the same end state — using:

- **Primary:** Redis SET on event ID after successful processing. Key `stripe_event:<event.id>` with TTL 30 days. If the key already exists when the event arrives: return `200` immediately without re-processing.
- **Secondary safety net:** `Payment.stripePaymentIntentId @unique` constraint in the schema. If we somehow miss the Redis check and try to create a duplicate Payment, the DB rejects with a unique-violation, which our handler catches as `already-processed` and returns 200.

```ts
// After signature verification, before dispatch:
const seen = await redis.get(`stripe_event:${event.id}`);
if (seen) return c.json(ok({ received: true, duplicate: true }), 200);

// ... dispatch + processing in DB transaction ...

// Only after the transaction commits:
await redis.set(`stripe_event:${event.id}`, '1', 'EX', 2592000); // 30 days
return c.json(ok({ received: true }), 200);
```

Edge case: if dispatch throws after the DB writes commit but before the Redis SET, Stripe will retry. The retry processes the same writes again. For most events this is idempotent at the data layer (setting status='active' twice = same state). For Payment creation specifically, the `@unique` constraint catches it. Trade-off accepted: a brief window where a successful event isn't yet flagged as "seen" in Redis.

### 1.3 Event dispatch table — six events handled, all others 200 no-op

Stripe sends many event types. We explicitly handle six. All others get `200 { received: true, unhandled: true }` — never 4xx (which would cause Stripe to retry forever).

| Event | Trigger | Handler does |
|---|---|---|
| `checkout.session.completed` | User completes Stripe Checkout (Stage 3A Pro activation OR Stage 3B free→pro upgrade) | Upsert Subscription; create first Payment; transition onboarding if applicable; send subscription-confirmation email |
| `invoice.payment_succeeded` | Recurring billing succeeded (after first month / first year) | Create Payment row; update Subscription.currentPeriodStart/End from Stripe; send payment-receipt email |
| `invoice.payment_failed` | Recurring billing failed | Create Payment row with status='failed'; do NOT change Subscription state (Stripe will retry); send payment-failed email |
| `customer.subscription.updated` | Subscription state changed Stripe-side (cancel_at_period_end flipped, billing cycle changed via schedule, etc.) | Sync local Subscription from Stripe state (status, currentPeriodEnd, cancel-pending flag if applicable) |
| `customer.subscription.deleted` | Subscription period ended (after cancellation OR after pro→free deferred downgrade) | Two cases — see §1.4 |
| `charge.refunded` | Refund processed (Stage 4B's refund endpoint triggers this Stripe-side) | Update Payment.status='refunded'; set Payment.refundAvailable=false; send refund-confirmation email |

For any event not in this table: log it as `unhandled_event_type` with the event type name, return 200, no processing. Future stages can add handlers without touching the dispatch wiring.

### 1.4 `customer.subscription.deleted` — two distinct cases

Stripe deletes the subscription when:
- (a) The Pro→Free deferred downgrade reaches its `currentPeriodEnd`. Local Subscription has `scheduledPlanId = 'free'` row.
- (b) The user cancelled (Stage 3B), the period ended naturally. Local Subscription has `status = 'cancelled'`, no `scheduledPlanId`.

Distinguish by reading the LOCAL Subscription row's state, NOT by anything in the Stripe event:

- If `subscription.scheduledPlanId` resolves to the 'free' plan row: **apply the downgrade**. Update Subscription: `planId` → 'free', `billingCycleId` → null, `statusId` → 'active', `stripeSubscriptionId` → null, `stripeCustomerId` → null, `currentPeriodStart` → null, `currentPeriodEnd` → null, `scheduledPlanId` → null, `scheduledBillingCycleId` → null. The user transitions from Pro to Free without losing their account. Send `sendPlanDowngradeAppliedEmail`.
- Else (cancellation reached period end, OR Stripe-side cancellation we didn't initiate): **set status='expired'**. Leave plan/billingCycle as they were (audit trail). The plan middleware will reject access from this point. Send `sendSubscriptionExpiredEmail`.

Find the local Subscription by `stripeSubscriptionId` from the event payload. If no local Subscription matches: log warning, return 200 (defensive — could be a test mode leak or out-of-sync state; we don't want to error).

### 1.5 Onboarding transitions in webhooks (Pro path)

Per Build Guide §4.1 step 5: "Stripe charges → POST /webhooks/stripe (verified, idempotent) → Payment=succeeded, Subscription→active, **verified → plan_selected → complete in the webhook handler**."

The `checkout.session.completed` handler must check the user's current `onboardingStatus.name` and transition `verified` → `complete` if the user is still mid-onboarding. (We collapse `plan_selected` → `complete` in a single step, same as the Free activation in Stage 3A.) If the user's status is already `plan_selected` or `complete` (e.g., this is a Stage 3B free→pro upgrade, not an initial activation), the transition is a no-op.

Use the existing `transitionToCompleteOnboarding(userId, tx)` helper from `users.repository.ts`. It's idempotent.

### 1.6 Raw body handling + route ordering in Hono

Hono's default JSON parsing kicks in when a handler calls `c.req.json()`. As long as the webhook handler reads `c.req.text()` first and never touches `.json()`, the raw bytes are preserved.

**Gotcha:** if you put the webhook route under a router that applies a JSON-parsing middleware upstream, the body gets parsed before the handler runs and the raw bytes are gone. Currently no middleware parses bodies upstream — confirm by reading `src/app.ts` and the existing routers. If anything is added later that DOES parse upstream, the webhook route would need to be lifted to a sibling of `/api/v1` (not nested under it) to avoid the parser. For Stage 4A: keep `/webhooks/stripe` under `/api/v1` per the architecture, since no parsing middleware exists upstream today.

### 1.7 No new env vars; no new runtime deps; no schema delta

Stage 4A uses only what's already installed and configured: `stripe` SDK (already a singleton in `src/lib/stripe.ts`), `STRIPE_WEBHOOK_SECRET` (already in `.env`), existing Subscription/Payment schema (already complete). No `npm install`, no Prisma migration. The Stage 4A delivery is purely module additions.

## 2. Module scope

```
src/modules/webhooks/webhooks.controller.ts       # NEW — mounts at /api/v1/webhooks
src/modules/webhooks/webhooks.service.ts          # NEW — signature verify + idempotency wrapper
src/modules/webhooks/stripe-handlers.ts           # NEW — one function per handled event type
src/modules/email/email.service.ts                # EDIT — add 4 new senders
src/modules/subscriptions/subscriptions.repository.ts  # EDIT — add 2 new helper functions for webhook-driven updates
tests/webhooks.test.ts                            # NEW — ~12 integration tests
tests/auth.test.ts, users.test.ts, subscriptions.test.ts  # EDIT — extend email mocks (4 new functions)
src/app.ts                                        # EDIT — mount webhooks router
```

Do NOT touch any other module directory.

## 3. Endpoint

### 3.1 `POST /webhooks/stripe` — receive verified events from Stripe

**No auth middleware** (Stripe is the caller; verification is signature-based, not session-based). The route handler:

1. Read raw body: `const rawBody = await c.req.text();`
2. Read signature header: `c.req.header('stripe-signature')`. If absent: `401 INVALID_SIGNATURE`.
3. Call `stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET)`. On throw: `401 INVALID_SIGNATURE`. Don't include the underlying Stripe error message in the response (avoid leaking signing details).
4. Idempotency check: `redis.get('stripe_event:' + event.id)`. If found: `200 { received: true, duplicate: true }`.
5. Dispatch to handler based on `event.type` (table in §1.3). All handlers return void; the controller wraps with shared error handling.
6. On handler success: `redis.set('stripe_event:' + event.id, '1', 'EX', 2592000)`. Respond `200 { received: true }`.
7. On handler throw (any non-validation error): log full error server-side. Respond `500 { error: { code: 'WEBHOOK_HANDLER_ERROR' } }`. Stripe will retry. Do NOT set the idempotency key (we want the retry to actually re-process).

If signature verification PASSED but the event type is unhandled: skip dispatch, log `event_unhandled`, set idempotency key, return `200 { received: true, unhandled: true }`. Stripe sees success and stops retrying.

## 4. Cross-cutting wiring

### 4.1 Email module additions

Add to `src/modules/email/email.service.ts`:

- `sendPaymentReceiptEmail({ to, fullName, amount, currency, periodStart, periodEnd })`
- `sendPaymentFailedEmail({ to, fullName, retryAt })` (Stripe retries on its own schedule; pass through)
- `sendRefundConfirmationEmail({ to, fullName, amount, currency })`
- `sendSubscriptionExpiredEmail({ to, fullName })`
- `sendPlanDowngradeAppliedEmail({ to, fullName, newPlan })`

(`sendSubscriptionConfirmationEmail` and `sendUpgradeEmail` already exist from prior stages.)

All fire-and-forget, same pattern. Update the email mock in `tests/auth.test.ts`, `tests/users.test.ts`, and `tests/subscriptions.test.ts` to include the new functions returning `vi.fn().mockResolvedValue(undefined)`.

### 4.2 Subscriptions repository — webhook-driven helpers

Add to `src/modules/subscriptions/subscriptions.repository.ts`:

- `upsertSubscriptionFromCheckout({ userId, plan, billingCycle, stripeCustomerId, stripeSubscriptionId, currentPeriodStart, currentPeriodEnd, tx? })` — used by `checkout.session.completed`. Handles both create-new (Stage 3A initial Pro) and update-existing-free (Stage 3B free→pro upgrade) via `prisma.subscription.upsert` keyed on `userId`.
- `applyScheduledDowngrade({ subscriptionId, tx? })` — used by `customer.subscription.deleted` when a Pro→Free downgrade reaches period end. Atomically: read the scheduled fields, apply them as the new live fields, clear the scheduled fields + Stripe fields + period dates + set status='active'.

Both take an optional `tx` (Prisma transaction client) so the controller can wrap multiple writes in a transaction.

### 4.3 Mount the webhooks router

In `src/app.ts`:

```ts
import { webhooksRouter } from './modules/webhooks/webhooks.controller.js';
// ...
api.route('/webhooks', webhooksRouter);
```

### 4.4 Payment row creation pattern

`Payment.userId` is `onDelete: SetNull` per the schema — payment history survives user deletion. When creating a Payment in the webhook (any handler), pass `userId` from the resolved Subscription. Don't fail the handler if the user can't be found (a deleted user can still have payments arriving from Stripe; we want to record them for audit even if `userId` ends up null).

Currency is stored as the lowercase 3-letter code (`'usd'`). Amount is stored as integer minor units (cents). Read both from the Stripe event's payment/invoice objects directly — don't transform.

## 5. Tests (Vitest, integration — new file `tests/webhooks.test.ts`)

Mock the Stripe SDK's `webhooks.constructEvent` since real signature verification requires a properly signed body (which is tedious to construct in tests). Stub it to either return the event payload you pass in OR throw a `Stripe.errors.StripeSignatureVerificationError`.

```ts
const { mockConstructEvent } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
  }));
  // Stripe.errors namespace is used by handler for typeof check; provide a stub
  (Stripe as any).errors = {
    StripeSignatureVerificationError: class extends Error {},
  };
  return { default: Stripe };
});
```

Then per-test, configure `mockConstructEvent.mockReturnValueOnce(<event payload>)` or `mockConstructEvent.mockImplementationOnce(() => { throw new Stripe.errors.StripeSignatureVerificationError('bad sig'); })`.

Test numbering continues from Stage 3B's 85:

86. **signature verification — valid sig** → 200 `{ received: true }`.
87. **signature verification — invalid sig** → 401 `INVALID_SIGNATURE`; no DB writes; no Redis key set.
88. **signature verification — missing signature header** → 401 `INVALID_SIGNATURE`.
89. **idempotency — same event ID twice** → first call processes (200 `received: true`); second call returns 200 `duplicate: true`; only one Payment row created.
90. **checkout.session.completed — new Pro user (Stage 3A path)** → Subscription created with plan='pro', billingCycle from metadata, status='active', Stripe IDs set, period dates from event; first Payment row created with status='succeeded'; User.onboardingStatus transitioned to 'complete'; receipt + confirmation emails called (assert mock).
91. **checkout.session.completed — free→pro upgrade (Stage 3B path)** → Subscription UPDATED (not created), planId switched from 'free' to 'pro', billingCycleId set; first recurring Payment row created; onboardingStatus stays 'complete'.
92. **invoice.payment_succeeded** → Payment row created (status='succeeded', stripePaymentIntentId set); Subscription.currentPeriodStart/End updated from event; receipt email called.
93. **invoice.payment_failed** → Payment row created (status='failed'); Subscription state NOT modified (still active); payment-failed email called.
94. **customer.subscription.updated (cancel_at_period_end flipped on)** → local Subscription.status set to 'cancelled'.
95. **customer.subscription.deleted — pro→free deferred downgrade path** → Subscription's scheduledPlanId was 'free'; handler applies the downgrade: plan='free', billingCycleId=null, statusId='active', Stripe IDs null, period dates null, scheduled* cleared; plan-downgrade-applied email called.
96. **customer.subscription.deleted — pure cancellation path** → Subscription's scheduledPlanId is null; handler sets status='expired'; plan/billingCycle UNCHANGED (audit trail); subscription-expired email called.
97. **charge.refunded** → Payment.status set to 'refunded', Payment.refundAvailable set to false; refund-confirmation email called.
98. **unhandled event type (e.g., `customer.created`)** → 200 `{ received: true, unhandled: true }`; no DB writes; idempotency key still set so retries are no-ops.

Each test seeds the DB state required and asserts the final DB state + the emails called. Mock both Stripe AND the email module.

**Total tests after Stage 4A:** 85 + 13 = **98 tests** (34 auth + 18 users + 28 subscriptions + 5 plan-middleware + 13 webhooks).

## 6. STOP-AND-ASK gates

1. **If the Stripe SDK's `Stripe.errors.StripeSignatureVerificationError` constructor signature differs** from the example in §5 (`new StripeSignatureVerificationError('msg')`), use the real constructor signature. Don't fake it with a generic Error — the handler's `instanceof` check may not work.
2. **If the test for `customer.subscription.deleted` (test 95)** triggers an unexpected error because `scheduledPlanId` was set without `scheduledBillingCycleId` being correctly nulled in Stage 3B's data, STOP and report. Re-check the data shape from `subscriptions.repository.ts`'s downgrade-write code.
3. **If the existing 85 tests fail** after adding email-module mock extensions, STOP. The new senders should be additive only; existing tests shouldn't see them at all.
4. **If signature verification throws an unexpected error type** (Stripe SDK quirk): catch it, log, and still respond 401. Don't 500 on signature failures — Stripe shouldn't retry those.

## 7. What NOT to do

- **No payments read endpoints.** `GET /payments`, `GET /payments/{id}` are Stage 4B.
- **No refund endpoint.** `POST /subscriptions/refund` is Stage 4B.
- **No `charge.dispute.created` or other dispute events.** Out of MVP scope.
- **No `customer.deleted`** — we don't delete Stripe customers, we just orphan the local Subscription.
- **No retroactive idempotency cleanup.** Old Redis keys auto-expire after 30 days; don't manually scan and delete.
- **No `stripe.events.retrieve(event.id)` to re-fetch the event from Stripe.** Trust the signed payload.
- **No JSON body parsing before signature verification.** Use `c.req.text()` exclusively.
- **No exposing webhook secrets or signatures in any log line.** Use `logger.debug` for the event ID; never log the raw signature.
- **No replaying old Stripe events from a Stripe dashboard "Resend" button.** Once Redis remembers the event ID for 30 days, replays are no-ops. If you genuinely need to replay (e.g., bug fix in handler logic), delete the Redis key manually.
- **No webhook event log table.** The Build Guide doesn't mandate it; stdout structured logs (already required by §6.8) are sufficient at MVP.
- **No new schema columns.** The schema covers everything Stage 4A needs.
- **No new env vars.**
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(webhooks): Stage 4A — Stripe webhook handler with signature verification + idempotency + 6 event handlers"
git log --oneline -5
```

Report:
- New commit SHA.
- One happy path + one error path test per major handler (curls or test-output excerpts).
- Vitest output: all **98 tests passing**.
- Confirmation no real Stripe webhook calls fire during tests (only the mocked `constructEvent` is invoked).
- The list of event types now dispatched (6 handlers + unhandled fallback).
- The idempotency mechanism (Redis key pattern + TTL).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
