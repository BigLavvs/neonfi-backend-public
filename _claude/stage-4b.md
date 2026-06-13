# Neonfi backend — Stage 4B: Payments read + refund

This file is the source-of-truth intent for Stage 4B. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `9cc0873` (Stage 4A — Stripe webhook handler).

## 0. Read first

In this order:

1. `_claude/stage-3a.md`, `_claude/stage-3b.md`, `_claude/stage-4a.md` (this repo). Stage 4B reads what 4A's webhooks write. The `refundAvailable` column is set to `true` by 4A's `handleInvoicePaymentSucceeded` and `handleCheckoutSessionCompleted`, flipped to `false` by `handleChargeRefunded`. The `Payment.status` lifecycle (`pending → succeeded → refunded`) is fully owned by webhooks; refund endpoint does NOT mutate Payment state directly.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **§Stage 4 PAYMENT + SUBSCRIPTION sections**, **§2.4 Pagination**, **§4.7 Cancellation / downgrade flow** (refund mentioned in step 1 of subscription management flow), **§2.6 Idempotency** (refund endpoint must be safe against double-clicks).
3. `Neonfi System Architecture.docx` — **PAYMENT** entity (URLs, resource rep, privacy rules), **SUBSCRIPTION** entity (`POST /subscriptions/refund` notes).
4. The frontend code that consumes these:
   - `src/routes/(dashboard)/payments/+page.ts` and `+page.svelte` — calls `GET /payments`, displays the payment history table, surfaces per-row refund eligibility.
   - `src/lib/components/modals/RefundConfirmModal.svelte` — calls `POST /subscriptions/refund` with `{ reason }` in the body. Read this to lock the request shape.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Pagination — offset-based [LOCKED by Build Guide §2.4]

Per Build Guide §2.4: "Offset pagination (portfolios, assets, transactions, payments): `?limit=20&offset=0`; `meta: { limit, offset, total }`."

`GET /payments` accepts `limit` (1–100, default 20) and `offset` (default 0). Validate via Zod. Return `meta: { limit, offset, total }` where `total` is the count of payments matching any active filters (NOT the user's lifetime total — must reflect filter state).

### 1.2 PaymentDTO shape + `refundAvailable` derivation [LOCKED]

The DTO mirrors `Neonfi System Architecture.docx` PAYMENT resource rep:

```ts
interface PaymentDTO {
  id: number;
  userId: number;
  subscriptionId: number;
  stripePaymentIntentId: string;
  amount: number;      // integer minor units (cents)
  currency: string;    // 'usd', lowercase
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  refundAvailable: boolean;
  createdAt: Date;
}
```

`refundAvailable` is a **derived** boolean even though the schema has a `refundAvailable` column. The DTO computes:

```ts
refundAvailable: payment.refundAvailable
  && payment.status.name === 'succeeded'
  && (Date.now() - payment.createdAt.getTime()) <= 3 * 24 * 60 * 60 * 1000
```

All three must be true. The column tracks "Stripe says this payment can be refunded AND we haven't already refunded it." The 3-day window is the application-level eligibility per Build Guide / architecture.txt "within 3 days of payment." The status check is belt-and-suspenders (a refunded payment can never be refunded again).

Don't expose the raw `refundAvailable` column to clients — always run it through the derivation.

### 1.3 Refund flow — endpoint requests, webhook confirms [LOCKED by §Stage 4]

`POST /subscriptions/refund` does NOT mutate Payment state. It validates eligibility, calls `stripe.refunds.create`, returns 200. The actual status flip (`succeeded → refunded`) and email send happen when Stripe's `charge.refunded` webhook arrives (Stage 4A's `handleChargeRefunded`). This prevents drift: Stripe is the source of truth for refund state; we mirror it through the webhook.

Idempotency: the refund endpoint can be called multiple times. The eligibility check naturally handles it — once the webhook fires and flips `refundAvailable` to false, a second click returns `400 REFUND_NOT_ELIGIBLE`. No additional idempotency key needed for this endpoint.

If `stripe.refunds.create` throws: return `400 REFUND_FAILED` with the Stripe error code in the meta. Do NOT 500 — this is a user-facing failure, not a server bug.

### 1.4 Which payment gets refunded — most recent succeeded [LOCKED]

The architecture lists `POST /subscriptions/refund` with no `paymentId` parameter, and the frontend's `RefundConfirmModal` sends only `{ reason }`. So the endpoint refunds the **most recent succeeded** payment for the user's subscription, automatically. The user doesn't choose which payment; the system does.

Find via: `prisma.payment.findFirst({ where: { userId, status: succeeded }, orderBy: { createdAt: 'desc' } })`. If none: `409 NO_PAYMENT_TO_REFUND`.

### 1.5 Cross-stage hygiene — transaction safety

Stage 4A learned the hard way: Neon's serverless pooler enforces a tight default `$transaction` timeout (~5s). Two patterns to follow whenever you write `prisma.$transaction(...)` in Stage 4B (refund endpoint may not need one, but if you do):

1. **Move static seed-data lookups outside the transaction.** Read `Plan`, `PaymentStatus`, `SubscriptionStatus`, etc. with the main `prisma` client BEFORE entering `$transaction`. Inside the transaction, use the cached values. Never make the transaction wait on lookups for rows that will never change.
2. **Pass `{ timeout: 15000 }`** to `prisma.$transaction(callback, { timeout: 15000 })`. 5s isn't enough headroom on Neon's pooled connection.

Stage 4B's refund endpoint should NOT need a transaction (it's: validate, call Stripe, return — no DB writes in the success path). But noting this pattern in case anyone touches a transaction-bearing helper.

### 1.6 No schema delta, no new env vars, no new runtime deps

Everything Stage 4B reads is already in the schema. Stripe SDK is already a singleton. No new packages. Pure module additions.

## 2. Module scope

```
src/modules/payments/payments.controller.ts       # NEW — mounts at /api/v1/payments
src/modules/payments/payments.service.ts          # NEW — list + read by ID
src/modules/payments/payments.schemas.ts          # NEW — Zod for pagination + filter query
src/modules/payments/payments.repository.ts       # NEW — listPaymentsByUser, findPaymentById
src/modules/payments/payments.dto.ts              # NEW — toPaymentDTO with derivation
src/modules/subscriptions/subscriptions.controller.ts  # EDIT — add POST /subscriptions/refund route
src/modules/subscriptions/subscriptions.service.ts     # EDIT — add refund() service function
src/app.ts                                        # EDIT — mount /api/v1/payments
tests/payments.test.ts                            # NEW — ~10 tests for GET endpoints
tests/subscriptions.test.ts                       # EDIT — add ~7 tests for refund (numbering continues 99+)
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `GET /payments` — list own payments (paginated)

**`requireAuth` middleware required.** Query (Zod, optional):

- `limit` — integer, 1–100, default 20
- `offset` — integer, ≥0, default 0
- `status` — `'pending' | 'succeeded' | 'failed' | 'refunded'`, optional filter

**Flow:**
1. Validate query params. Bad input → `400 VALIDATION_ERROR`.
2. Run two queries in parallel:
   - `prisma.payment.findMany({ where: { userId, ...statusFilter }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset, include: { status: true } })`
   - `prisma.payment.count({ where: { userId, ...statusFilter } })`
3. Map each through `toPaymentDTO()` (handles the `refundAvailable` derivation).
4. Respond: `200 { data: { payments: [...] }, meta: { limit, offset, total } }`.

### 3.2 `GET /payments/{id}` — read one payment

**`requireAuth` middleware required.** Path param: `id` (positive integer; validate via Zod or `c.req.param`).

**Flow:**
1. Parse `id`. Invalid → `400 VALIDATION_ERROR`.
2. `prisma.payment.findUnique({ where: { id }, include: { status: true } })`.
3. **Uniform 403** if (a) not found OR (b) `payment.userId !== currentUser.id`. Same pattern as `DELETE /auth/sessions/{id}` — no enumeration leak.
4. Map through `toPaymentDTO()`.
5. Respond: `200 { data: { payment: <PaymentDTO> } }`.

### 3.3 `POST /subscriptions/refund` — request refund of most recent payment

**`requireAuth` middleware required.** Body (Zod, `.strict()`):

```json
{ "reason": "<optional string, max 500 chars>" }
```

`reason` is optional. Frontend's `RefundConfirmModal` sends it; backend forwards to Stripe.

**Flow:**
1. Validate body. Unknown field → `400 VALIDATION_ERROR`.
2. Find user's subscription. If none: `409 NO_SUBSCRIPTION_TO_REFUND`.
3. Find most recent succeeded Payment for the user: `prisma.payment.findFirst({ where: { userId, status: { name: 'succeeded' } }, orderBy: { createdAt: 'desc' }, include: { status: true } })`. If none: `409 NO_PAYMENT_TO_REFUND`.
4. Eligibility check — all three must be true:
   - `payment.refundAvailable === true`
   - `payment.status.name === 'succeeded'`
   - `(now - payment.createdAt) <= 3 days`
   If any fails: `400 REFUND_NOT_ELIGIBLE`.
5. Call `stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId, reason: reasonOrUndefined })`. Stripe accepts these `reason` values: `'duplicate' | 'fraudulent' | 'requested_by_customer'`. The frontend sends a free-text reason; map it to `'requested_by_customer'` if non-empty, else omit. **Do NOT pass the frontend's free text to Stripe's `reason` field** — Stripe will reject anything not in their enum. Pass the free text instead via `metadata: { user_reason: <free text, truncated to 500 chars> }`.
6. On Stripe throw: `400 REFUND_FAILED` with `meta: { stripeCode: <error.code> }`.
7. Do NOT mutate Payment.status or refundAvailable here — wait for the webhook (`charge.refunded` in Stage 4A).
8. Respond: `200 { data: { refundRequested: true, paymentId: payment.id } }`.

The Stripe webhook will fire within seconds to minutes; the frontend can poll `GET /payments/{paymentId}` to see the status change to `'refunded'`, or rely on the success response and trust the eventual webhook update.

## 4. Cross-cutting wiring

### 4.1 Mount the payments router

In `src/app.ts`, after the subscriptions router:

```ts
import { paymentsRouter } from './modules/payments/payments.controller.js';
// ...
api.route('/payments', paymentsRouter);
```

### 4.2 Refund service reuses Stripe singleton

`subscriptions.service.ts` imports `stripe` from `src/lib/stripe.js` — same singleton 4A uses. No new client construction.

### 4.3 Test mocks — extend stripe mock for `refunds.create`

In `tests/subscriptions.test.ts`, the existing Stripe mock covers `checkout.sessions`, `subscriptions`, `subscriptionSchedules`. Add `refunds.create`:

```ts
const {
  // ...existing mocks
  mockRefundsCreate,
} = vi.hoisted(() => ({
  // ...
  mockRefundsCreate: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    // ...existing
    refunds: { create: mockRefundsCreate },
  }));
  return { default: Stripe };
});

// In beforeEach:
mockRefundsCreate.mockResolvedValue({ id: 're_test_refund_id', status: 'succeeded' });
```

`tests/payments.test.ts` doesn't need to mock Stripe at all — the GET endpoints don't call Stripe.

## 5. Tests (Vitest, integration)

Test numbering continues from Stage 4A's 98:

### 5.1 `tests/payments.test.ts` (~10 new tests, 99–108)

Use the same cleanup pattern as `subscriptions.test.ts`. Seed users + subscriptions + payments per-test as needed.

Helper for seeding payments:
```ts
async function seedPayment(opts: {
  userId: number;
  subscriptionId: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amount?: number;
  refundAvailable?: boolean;
  createdAt?: Date;
}): Promise<Payment> {
  const statusRow = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: opts.status } });
  return prisma.payment.create({
    data: {
      userId: opts.userId,
      subscriptionId: opts.subscriptionId,
      stripePaymentIntentId: `pi_test_${Math.random().toString(36).slice(2)}`,
      amount: opts.amount ?? 2000,
      currency: 'usd',
      statusId: statusRow.id,
      refundAvailable: opts.refundAvailable ?? (opts.status === 'succeeded'),
      ...(opts.createdAt && { createdAt: opts.createdAt }),
    },
  });
}
```

99. **GET /payments — auth, no payments** → 200, `data.payments: []`, `meta: { limit: 20, offset: 0, total: 0 }`.
100. **GET /payments — multiple payments, default pagination** → 200, payments returned newest-first, total matches count, each DTO has all required fields.
101. **GET /payments — `?limit=5&offset=5`** → 200, returns the 6th–10th payments (by createdAt DESC), meta reflects the params.
102. **GET /payments — `?status=succeeded`** → 200, only succeeded payments returned, total = count of succeeded.
103. **GET /payments — cross-user isolation** → user A has 3 payments, user B has 0; user B's request returns empty list (verify userId filtering).
104. **GET /payments — no auth** → 401.
105. **GET /payments — invalid `limit` (e.g. 0 or 200)** → 400 `VALIDATION_ERROR`.
106. **GET /payments/{id} — own payment** → 200, DTO returned, `refundAvailable` derived correctly (true for succeeded ≤3d old, false for older).
107. **GET /payments/{id} — another user's payment** → 403 `FORBIDDEN`.
108. **GET /payments/{id} — non-existent ID** → 403 `FORBIDDEN` (uniform with cross-user).

### 5.2 `tests/subscriptions.test.ts` (~7 new tests, 109–115)

Reuse the existing `createProSubscription` helper from Stage 3B. Add the `seedPayment` helper inline (or extract to `tests/helpers.ts` if it's getting reused).

109. **POST /subscriptions/refund — eligible succeeded payment within 3 days** → 200, `data.refundRequested: true`, `paymentId` matches the seeded payment; `mockRefundsCreate` called with the correct `payment_intent` and `reason: 'requested_by_customer'`; user reason passed in `metadata.user_reason`; **Payment row NOT mutated locally** (status stays 'succeeded' — webhook handles the flip).
110. **POST /subscriptions/refund — no reason** → 200, mockRefundsCreate called WITHOUT a `reason` field and WITHOUT `metadata.user_reason`.
111. **POST /subscriptions/refund — payment >3 days old** → 400 `REFUND_NOT_ELIGIBLE`; Stripe NOT called.
112. **POST /subscriptions/refund — payment.refundAvailable=false** → 400 `REFUND_NOT_ELIGIBLE`; Stripe NOT called.
113. **POST /subscriptions/refund — no successful payments** → 409 `NO_PAYMENT_TO_REFUND` (subscription exists, only failed/pending payments exist).
114. **POST /subscriptions/refund — no subscription** → 409 `NO_SUBSCRIPTION_TO_REFUND`; Stripe NOT called.
115. **POST /subscriptions/refund — Stripe throws** → 400 `REFUND_FAILED` with `meta.stripeCode`; no DB writes.

**Total tests after Stage 4B: 115** (34 auth + 18 users + 35 subscriptions + 5 plan-middleware + 13 webhooks + 10 payments).

## 6. STOP-AND-ASK gates

1. **If Stripe rejects all four allowed `reason` values** (Stripe occasionally changes their enum), STOP and report which strings are accepted in the installed SDK version. The architecture assumes `'requested_by_customer'` works; if it doesn't, the spec needs adjustment.
2. **If the existing 98 tests fail after adding Stripe `refunds.create` mock**, STOP — the new mock shouldn't affect any prior test path (no prior code calls refunds.create).
3. **If `prisma.payment.findFirst` with status filter on the `name` field needs unexpected `include`/`select` shape**, surface it. The pattern should mirror how 4A's webhook handlers query Payment with `status: { name: 'succeeded' }`.

## 7. What NOT to do

- **No new schema columns.** The Payment table is already complete.
- **No new env vars.**
- **No mutating Payment.status in the refund endpoint.** Webhook (`charge.refunded`) owns that transition.
- **No mutating Payment.refundAvailable in the refund endpoint.** Same — webhook owns it.
- **No sending refund emails from the refund endpoint.** Webhook (`handleChargeRefunded` in Stage 4A) sends `sendRefundConfirmationEmail`. Don't double-send.
- **No retry-loop on Stripe errors.** One call, surface the error, let the user click again.
- **No taking a `paymentId` parameter on the refund endpoint.** The architecture defines it as subscription-level (refund the most recent payment) — adding a paymentId would diverge.
- **No filtering revoked/expired in the payments list.** Payment is append-only; status reflects the row's current state.
- **No exposing `payment.refundAvailable` raw column value.** Always derive (column AND status='succeeded' AND ≤3 days).
- **No CDN/caching headers on these endpoints.** Per Build Guide §6.3: "No CDN for authenticated data."
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**
- **No introducing `prisma.$transaction` in this stage unless genuinely needed** — and if you do, follow the §1.5 pattern (lookups outside, `{ timeout: 15000 }`).

## 8. Commit and report

```bash
git add -A
git commit -m "feat(payments): Stage 4B — GET /payments + GET /payments/{id} + POST /subscriptions/refund"
git log --oneline -5
```

Report:
- New commit SHA.
- One happy path + one error path test per endpoint (curls or test excerpts).
- Vitest output: all **115 tests passing**.
- Where `toPaymentDTO` lives.
- Confirmation refund endpoint does NOT mutate Payment row (webhook is the only writer of refund state).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
