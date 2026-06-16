# retrofit-25: fix Stripe Basil/Dahlia field relocations in webhook handlers (checkout.session.completed 500)

## Why (root cause — confirmed live + against Stripe docs)
`src/lib/stripe.ts` pins `apiVersion: '2026-05-27.dahlia'`. As of the **Basil release (2025-03-31)** Stripe made two breaking changes:

1. **Removed `current_period_start` / `current_period_end` from the Subscription resource** — they now live on each **SubscriptionItem** (`items.data[].current_period_start/end`).
   https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
2. **Removed `subscription` from InvoiceLineItem and added `Invoice.parent`** — the subscription ref is now `invoice.parent.subscription_details.subscription`.
   https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

`handleCheckoutSessionCompleted` reads `stripeSub.current_period_start` (now `undefined`) → `new Date(undefined * 1000)` = **Invalid Date** → Prisma rejects the DateTime write → the `$transaction` (subscription upsert + payment.create + onboarding-complete) **rolls back** → webhook returns **500**. Net effect: Pro never activates AND no Payment row is written (both are in that one transaction).

Observed live: `checkout.session.completed → [500]` while every other event returns 200. The suite is green because the webhook tests mock `subscriptions.retrieve` with the OLD top-level shape, so they never exercise the real dahlia response.

---

## Part 1 — checkout handler: read the period from the subscription ITEM (THE 500 FIX)
File: `src/modules/webhooks/stripe-handlers.ts`, `handleCheckoutSessionCompleted` (≈ lines 71-74).

With apiVersion dahlia + `typescript: true`, the SDK types expose `items.data[].current_period_start/end` as typed numbers, so prefer real types over `as unknown as`. Replace:

```ts
const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
const rawSub = stripeSub as unknown as { current_period_start: number; current_period_end: number };
const currentPeriodStart = new Date(rawSub.current_period_start * 1000);
const currentPeriodEnd = new Date(rawSub.current_period_end * 1000);
```

with:

```ts
const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
// Basil (2025-03-31)+ removed current_period_start/end from Subscription; they
// now live on each SubscriptionItem. apiVersion is pinned to dahlia (src/lib/stripe.ts).
const item = stripeSub.items.data[0];
if (!item?.current_period_start || !item?.current_period_end) {
  throw new Error(
    `checkout.session.completed: subscription ${stripeSubscriptionId} has no item billing period`,
  );
}
const currentPeriodStart = new Date(item.current_period_start * 1000);
const currentPeriodEnd = new Date(item.current_period_end * 1000);
```

If the installed types still don't surface these on the item, cast the ITEM (not the subscription): `(item as unknown as { current_period_start: number; current_period_end: number })`. NEVER write an Invalid Date to Prisma — the guard above prevents it.

---

## Part 2 — same fix in `handleSubscriptionUpdated` (cancel/renewal path)
Same file, `handleSubscriptionUpdated` (≈ lines 254-274). The event's subscription object has the same dahlia shape. Read the period from `items.data[0]`, and only set the period fields when present so a missing period can never write an Invalid Date:

```ts
const raw = event.data.object as unknown as {
  id: string;
  cancel_at_period_end: boolean;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
};
const period = raw.items?.data?.[0];
// ... localSub lookup unchanged ...
const updateData: Record<string, unknown> = {};
if (period?.current_period_start && period?.current_period_end) {
  updateData.currentPeriodStart = new Date(period.current_period_start * 1000);
  updateData.currentPeriodEnd = new Date(period.current_period_end * 1000);
}
```

Keep the existing `cancel_at_period_end` → status logic (it appends `statusId` to `updateData`), then `subscription.update`.

---

## Part 3 — invoice handlers: subscription ref via `parent` (renewal recording)
`handleInvoicePaymentSucceeded` + `handleInvoicePaymentFailed` read `invoice.subscription`, which Basil relocated. Under dahlia `invoice.subscription` is likely `undefined` → both handlers hit their `!stripeSubscriptionId` early-return → **renewal payments are silently never recorded**. (Not the current symptom — first payment is handled by checkout.session.completed — but fix it now.)

- Read the subscription id from `invoice.parent?.subscription_details?.subscription`, falling back to the legacy `invoice.subscription` only if the installed type still has it. Apply the existing `toStr()` normalisation.
- Verify against the pinned SDK types whether `invoice.period_start` / `period_end` still exist at top level; if not, use `invoice.lines.data[0].period.start/end`.
- DO NOT guess the shapes — read `node_modules/stripe/types/Invoices.d.ts` (and `InvoiceLineItems.d.ts`) and use whatever the dahlia types actually expose.

---

## Part 4 — make the tests reflect the real (dahlia) shape so this can't regress
Grep `tests/` for `current_period_start` / `current_period_end`, the `subscriptions.retrieve` mock, and the `checkout.session.completed` + `customer.subscription.updated` event fixtures.

- Move `current_period_start/end` into `items.data[0]` in every Stripe subscription mock/fixture (dahlia shape). Move the invoice subscription ref under `parent.subscription_details.subscription`.
- Add/strengthen a `checkout.session.completed` test asserting AFTER processing: the user's subscription is `plan=pro`, `status=active`, `currentPeriodEnd` is a valid future Date; a Payment row exists (correct amount, `status=succeeded`); onboarding is `completed`. This is the regression guard that would have caught the 500.

---

## Gate
`npx vitest run tests/webhooks.test.ts tests/subscriptions.test.ts tests/auth.test.ts` (adjust the webhook test filename if different; DATABASE_URL_TEST set, dev server stopped) → green.

## Commit (explicit add, no -A)
```bash
git add src/modules/webhooks/stripe-handlers.ts tests/webhooks.test.ts _claude/retrofit-25.md
# + any invoice-related file you actually edited
git commit -m "fix(webhooks): read Stripe billing period from subscription items + invoice.parent (Basil/Dahlia field relocation); fixes checkout.session.completed 500 (retrofit-25)"
```
Report SHA + confirm the suites pass.
