// Neonfi backend — Stripe webhook event handlers (Stage 4A).
//
// One exported function per handled event type. Each function receives the
// verified Stripe.Event and performs the required DB writes + fire-and-forget
// emails. All functions are called by webhooks.service.ts after signature
// verification and idempotency check pass.
//
// Raw Stripe object types are cast through `unknown` where the SDK's TS types
// don't expose the field directly (same pattern as subscriptions.service.ts).

import type Stripe from 'stripe';
import { stripe } from '../../lib/stripe.js';
import { prisma } from '../../lib/prisma.js';
import {
  upsertSubscriptionFromCheckout,
  applyScheduledDowngrade,
} from '../subscriptions/subscriptions.repository.js';
import { transitionToCompleteOnboarding } from '../users/users.repository.js';
import {
  sendSubscriptionConfirmationEmail,
  sendPaymentReceiptEmail,
  sendPaymentFailedEmail,
  sendRefundConfirmationEmail,
  sendSubscriptionExpiredEmail,
  sendPlanDowngradeAppliedEmail,
} from '../email/email.service.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fireEmail(fn: () => Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch (e) {
      console.error('[webhooks] email failed', e instanceof Error ? e.message : e);
    }
  })();
}

/** Normalise a Stripe field that can be either an ID string or an expanded object. */
function toStr(val: string | { id: string } | null | undefined): string | null {
  if (!val) return null;
  return typeof val === 'string' ? val : val.id;
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

export async function handleCheckoutSessionCompleted(event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  const userId = parseInt(session.metadata?.userId ?? '', 10);
  if (!userId || isNaN(userId)) {
    console.warn('[webhooks] checkout.session.completed: missing userId in metadata', { eventId: event.id });
    return;
  }

  const billingCycle = (session.metadata?.billingCycle ?? 'monthly') as 'monthly' | 'yearly';
  const stripeCustomerId = toStr(session.customer as string | { id: string } | null);
  const stripeSubscriptionId = toStr(session.subscription as string | { id: string } | null);

  if (!stripeSubscriptionId) {
    console.warn('[webhooks] checkout.session.completed: no subscription ID', { eventId: event.id });
    return;
  }

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const rawSub = stripeSub as unknown as { current_period_start: number; current_period_end: number };
  const currentPeriodStart = new Date(rawSub.current_period_start * 1000);
  const currentPeriodEnd = new Date(rawSub.current_period_end * 1000);

  const paymentIntentId = toStr(session.payment_intent as string | { id: string } | null);

  // Lookup outside tx — static seed data, safe to read before the transaction.
  const succeededStatus = paymentIntentId
    ? await prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'succeeded' } })
    : null;

  await prisma.$transaction(async (tx) => {
    const sub = await upsertSubscriptionFromCheckout({
      userId,
      billingCycle,
      stripeCustomerId,
      stripeSubscriptionId,
      currentPeriodStart,
      currentPeriodEnd,
      tx,
    });

    if (paymentIntentId && succeededStatus) {
      await tx.payment.create({
        data: {
          userId,
          subscriptionId: sub.id,
          stripePaymentIntentId: paymentIntentId,
          amount: session.amount_total ?? 0,
          currency: (session.currency ?? 'usd').toLowerCase(),
          statusId: succeededStatus.id,
          refundAvailable: true,
        },
      });
    }

    await transitionToCompleteOnboarding(userId, tx);
  }, { timeout: 15000 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user) {
    fireEmail(() => sendSubscriptionConfirmationEmail({ to: user.email, fullName: user.fullName, plan: 'pro' }));
    if (paymentIntentId) {
      fireEmail(() => sendPaymentReceiptEmail({
        to: user.email,
        fullName: user.fullName,
        amount: session.amount_total ?? 0,
        currency: (session.currency ?? 'usd').toLowerCase(),
        periodStart: currentPeriodStart,
        periodEnd: currentPeriodEnd,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// invoice.payment_succeeded
// ---------------------------------------------------------------------------

export async function handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as unknown as {
    subscription: string | { id: string } | null;
    payment_intent: string | null;
    amount_paid: number;
    currency: string;
    period_start: number;
    period_end: number;
  };
  const stripeSubscriptionId = toStr(invoice.subscription);
  const paymentIntentId = toStr(invoice.payment_intent);

  if (!stripeSubscriptionId || !paymentIntentId) {
    console.warn('[webhooks] invoice.payment_succeeded: missing subscription or payment_intent', { eventId: event.id });
    return;
  }

  const localSub = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId },
    include: { user: true },
  });
  if (!localSub) {
    console.warn('[webhooks] invoice.payment_succeeded: no local subscription', { stripeSubscriptionId });
    return;
  }

  // Lookup outside tx — static seed data.
  const [succeededStatus] = await Promise.all([
    prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'succeeded' } }),
  ]);
  const periodStart = new Date(invoice.period_start * 1000);
  const periodEnd = new Date(invoice.period_end * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        userId: localSub.userId,
        subscriptionId: localSub.id,
        stripePaymentIntentId: paymentIntentId,
        amount: invoice.amount_paid,
        currency: invoice.currency.toLowerCase(),
        statusId: succeededStatus.id,
        refundAvailable: true,
      },
    });
    await tx.subscription.update({
      where: { id: localSub.id },
      data: { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
    });
  }, { timeout: 15000 });

  if (localSub.user) {
    fireEmail(() => sendPaymentReceiptEmail({
      to: localSub.user!.email,
      fullName: localSub.user!.fullName,
      amount: invoice.amount_paid,
      currency: invoice.currency.toLowerCase(),
      periodStart,
      periodEnd,
    }));
  }
}

// ---------------------------------------------------------------------------
// invoice.payment_failed
// ---------------------------------------------------------------------------

export async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as unknown as {
    subscription: string | { id: string } | null;
    payment_intent: string | null;
    amount_due: number;
    currency: string;
    next_payment_attempt: number | null;
  };
  const stripeSubscriptionId = toStr(invoice.subscription);

  if (!stripeSubscriptionId) {
    console.warn('[webhooks] invoice.payment_failed: no subscription ID', { eventId: event.id });
    return;
  }

  const localSub = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId },
    include: { user: true },
  });
  if (!localSub) {
    console.warn('[webhooks] invoice.payment_failed: no local subscription', { stripeSubscriptionId });
    return;
  }

  // Use payment_intent if present; fall back to a stable composite key so the
  // @unique constraint is still satisfied when Stripe retries without a new PI.
  const intentId = invoice.payment_intent ?? `failed_${event.id}`;

  const failedStatus = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'failed' } });

  await prisma.payment.create({
    data: {
      userId: localSub.userId,
      subscriptionId: localSub.id,
      stripePaymentIntentId: intentId,
      amount: invoice.amount_due,
      currency: invoice.currency.toLowerCase(),
      statusId: failedStatus.id,
      refundAvailable: false,
    },
  });

  if (localSub.user) {
    const retryAt = invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null;
    fireEmail(() => sendPaymentFailedEmail({
      to: localSub.user!.email,
      fullName: localSub.user!.fullName,
      retryAt,
    }));
  }
}

// ---------------------------------------------------------------------------
// customer.subscription.updated
// ---------------------------------------------------------------------------

export async function handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
  const raw = event.data.object as unknown as {
    id: string;
    cancel_at_period_end: boolean;
    current_period_start: number;
    current_period_end: number;
  };

  const localSub = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId: raw.id },
    include: { status: true },
  });
  if (!localSub) {
    console.warn('[webhooks] customer.subscription.updated: no local subscription', { stripeSubscriptionId: raw.id });
    return;
  }

  const updateData: Record<string, unknown> = {
    currentPeriodStart: new Date(raw.current_period_start * 1000),
    currentPeriodEnd: new Date(raw.current_period_end * 1000),
  };

  if (raw.cancel_at_period_end && localSub.status.name === 'active') {
    const cancelledStatus = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'cancelled' } });
    updateData.statusId = cancelledStatus.id;
  } else if (!raw.cancel_at_period_end && localSub.status.name === 'cancelled') {
    const activeStatus = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
    updateData.statusId = activeStatus.id;
  }

  await prisma.subscription.update({ where: { id: localSub.id }, data: updateData });
}

// ---------------------------------------------------------------------------
// customer.subscription.deleted
// ---------------------------------------------------------------------------

export async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const raw = event.data.object as unknown as { id: string };

  const localSub = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId: raw.id },
    include: { scheduledPlan: true, user: true },
  });
  if (!localSub) {
    console.warn('[webhooks] customer.subscription.deleted: no local subscription', { stripeSubscriptionId: raw.id });
    return;
  }

  if (localSub.scheduledPlanId !== null && localSub.scheduledPlan?.name === 'free') {
    await prisma.$transaction(async (tx) => {
      await applyScheduledDowngrade(localSub.id, tx);
    }, { timeout: 15000 });
    if (localSub.user) {
      fireEmail(() => sendPlanDowngradeAppliedEmail({
        to: localSub.user!.email,
        fullName: localSub.user!.fullName,
        newPlan: 'free',
      }));
    }
  } else {
    const expiredStatus = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'expired' } });
    await prisma.subscription.update({ where: { id: localSub.id }, data: { statusId: expiredStatus.id } });
    if (localSub.user) {
      fireEmail(() => sendSubscriptionExpiredEmail({
        to: localSub.user!.email,
        fullName: localSub.user!.fullName,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

export async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const raw = event.data.object as unknown as {
    payment_intent: string | null;
    amount_refunded: number;
    currency: string;
  };

  const paymentIntentId = raw.payment_intent;
  if (!paymentIntentId) {
    console.warn('[webhooks] charge.refunded: no payment_intent', { eventId: event.id });
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { user: true },
  });
  if (!payment) {
    console.warn('[webhooks] charge.refunded: no local payment found', { paymentIntentId });
    return;
  }

  const refundedStatus = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'refunded' } });
  await prisma.payment.update({
    where: { id: payment.id },
    data: { statusId: refundedStatus.id, refundAvailable: false },
  });

  if (payment.user) {
    fireEmail(() => sendRefundConfirmationEmail({
      to: payment.user!.email,
      fullName: payment.user!.fullName,
      amount: raw.amount_refunded,
      currency: raw.currency.toLowerCase(),
    }));
  }
}
