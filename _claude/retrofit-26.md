# retrofit-26: record subscription payments (Basil removed invoice.payment_intent)

(Scope reduced — the former "auto-add asset on buy" moved into retrofit-27 §6 so it lands with the average-cost model.)

## Why
`src/lib/stripe.ts` pins `apiVersion: '2026-05-27.dahlia'`. The **Basil release (2025-03-31)** removed `payment_intent`, `charge`, `paid`, `paid_out_of_band` from the **Invoice** object; the PaymentIntent is now reached by expanding `payments.data.payment.payment_intent`.
https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices

Subscription-mode Checkout sessions have a null `session.payment_intent`, so `handleCheckoutSessionCompleted` never writes a Payment row (by design the row comes from `invoice.payment_succeeded`). But `handleInvoicePaymentSucceeded` reads `invoice.payment_intent` (≈ line 154), now always `undefined` → early-return → no Payment row → Payments page history is empty.

## Fix — `src/modules/webhooks/stripe-handlers.ts`
Verify the shape against `node_modules/stripe/types/Invoices.d.ts` (look for `payments`, `confirmation_secret`; legacy `payment_intent` should be gone). In `handleInvoicePaymentSucceeded`, resolve the PI by retrieving the invoice expanded (the webhook payload isn't expanded):

```ts
let paymentIntentId = toStr(
  (invoice as { payment_intent?: string | { id: string } | null }).payment_intent ?? null,
); // legacy fallback if the pinned types still expose it
if (!paymentIntentId && invoice.id) {
  const full = await stripe.invoices.retrieve(invoice.id, {
    expand: ['payments.data.payment.payment_intent'],
  });
  const pay = (full as unknown as {
    payments?: { data?: Array<{ payment?: { payment_intent?: string | { id: string } | null } }> };
  }).payments?.data?.[0];
  paymentIntentId = toStr(pay?.payment?.payment_intent ?? null);
}
```
`amount_paid`, `currency`, `period_start/end` were NOT removed — confirm in the types. If `paymentIntentId` is still null, log + return (don't fabricate an id — `charge.refunded` matches on the real PI). Apply the same resolution to `handleInvoicePaymentFailed` (keep its `failed_${event.id}` fallback).

## Backfill the existing payment
After deploy + restart, resend the already-delivered event (the subscription now exists):
```
stripe events resend evt_1Tj3n4Ak1U3AIcxNXQmOBZeZ
```

## Tests + commit
Update `tests/webhooks.test.ts`: invoice fixtures use the dahlia shape (no top-level `payment_intent`); mock `stripe.invoices.retrieve` → `payments.data[0].payment.payment_intent`; assert a Payment row is created. Gate: `npx vitest run tests/webhooks.test.ts tests/subscriptions.test.ts` green.
```bash
git add src/modules/webhooks/stripe-handlers.ts tests/webhooks.test.ts _claude/retrofit-26.md
git commit -m "fix(webhooks): resolve invoice PaymentIntent via payments expansion (Basil removed invoice.payment_intent); records subscription payments (retrofit-26)"
```
Report SHA + confirm suites pass.
