// Neonfi backend — Subscriptions module: service layer (Stage 3A/3B).
//
// Stage 3A paths:
//   Free  — synchronous activation: Subscription row + onboarding 'complete' in one TX.
//   Pro   — Stripe Checkout URL only; Stage 4 webhook creates the row.
//
// Stage 3B paths:
//   upgrade   — free→pro (checkout), monthly→yearly (immediate Stripe update)
//   downgrade — pro→free (cancel_at_period_end), yearly→monthly (schedule)
//   cancel    — cancel_at_period_end: true; idempotent if already cancelled

import { prisma } from '../../lib/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { REFUND_WINDOW_MS } from '../../lib/constants.js';
import {
  createFreeSubscription,
  findSubscriptionByUserId,
  updateSubscriptionById,
} from './subscriptions.repository.js';
import { toSubscriptionDTO, type SubscriptionDTO } from './subscriptions.dto.js';
import { transitionToCompleteOnboarding } from '../users/users.repository.js';
import {
  sendSubscriptionConfirmationEmail,
  sendUpgradeEmail,
  sendDowngradeScheduledEmail,
  sendCancellationScheduledEmail,
} from '../email/email.service.js';
import type { UserWithRelations } from '../users/users.repository.js';
import type { CreateSubscriptionBody, UpgradeSubscriptionBody, DowngradeSubscriptionBody, RefundSubscriptionBody } from './subscriptions.schemas.js';

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

export class SubscriptionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

// ---------------------------------------------------------------------------
// Soft plan helper — never 403s; returns 'free' for no-sub / expired cases
// ---------------------------------------------------------------------------

export async function getEffectivePlan(userId: number): Promise<'free' | 'pro'> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true, status: true },
  });
  if (!subscription) return 'free';
  const now = new Date();
  const effectivelyActive =
    subscription.status.name === 'active' ||
    (subscription.status.name === 'cancelled' &&
      subscription.currentPeriodEnd !== null &&
      subscription.currentPeriodEnd > now);
  if (!effectivelyActive) return 'free';
  return subscription.plan.name as 'free' | 'pro';
}

// ---------------------------------------------------------------------------
// Shared helper: build a Stripe Checkout session URL for Pro
// ---------------------------------------------------------------------------

async function createProCheckoutSession(
  user: UserWithRelations,
  billingCycle: 'monthly' | 'yearly',
  returnPath: '/onboarding' | '/payments' | '/dashboard' = '/dashboard',
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{
      price: billingCycle === 'monthly'
        ? config.STRIPE_PRO_MONTHLY_PRICE_ID
        : config.STRIPE_PRO_YEARLY_PRICE_ID,
      quantity: 1,
    }],
    customer_email: user.email,
    client_reference_id: String(user.id),
    metadata: {
      userId: String(user.id),
      plan: 'pro',
      billingCycle,
    },
    success_url: `${config.APP_BASE_URL}${returnPath}?subscription=activated`,
    cancel_url: `${config.APP_BASE_URL}${returnPath}?subscription=cancelled`,
  });

  if (!session.url) {
    throw new SubscriptionError(500, 'STRIPE_ERROR', 'Failed to create Stripe Checkout Session');
  }

  return session.url;
}

// ---------------------------------------------------------------------------
// Fire-and-forget email helper
// ---------------------------------------------------------------------------

function fireEmail(fn: () => Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch (e) {
      console.error('[subscriptions] email failed', e instanceof Error ? e.message : e);
    }
  })();
}

// ---------------------------------------------------------------------------
// activateSubscription — POST /subscriptions
// ---------------------------------------------------------------------------

export async function activateSubscription(
  user: UserWithRelations,
  body: CreateSubscriptionBody,
): Promise<{ subscription: SubscriptionDTO } | { checkoutUrl: string }> {
  const statusName = user.onboardingStatus.name;
  if (statusName === 'pending_verification') {
    throw new SubscriptionError(403, 'EMAIL_NOT_VERIFIED', 'Email must be verified before activating a subscription');
  }
  if (statusName === 'plan_selected' || statusName === 'complete') {
    throw new SubscriptionError(409, 'SUBSCRIPTION_ALREADY_ACTIVATED', 'Subscription is already activated');
  }

  if (body.plan === 'free') {
    const subscription = await prisma.$transaction(async (tx) => {
      const sub = await createFreeSubscription(user.id, tx);
      await transitionToCompleteOnboarding(user.id, tx);
      return sub;
    }, { timeout: 15000 });

    fireEmail(() => sendSubscriptionConfirmationEmail({
      to: user.email,
      fullName: user.fullName,
      plan: 'free',
    }));

    return { subscription: toSubscriptionDTO(subscription) };
  }

  const checkoutUrl = await createProCheckoutSession(user, body.billingCycle!, body.returnPath);
  return { checkoutUrl };
}

// ---------------------------------------------------------------------------
// getMySubscription — GET /subscriptions/me
// ---------------------------------------------------------------------------

export async function getMySubscription(
  userId: number,
): Promise<{ subscription: SubscriptionDTO }> {
  const subscription = await findSubscriptionByUserId(userId);
  if (!subscription) {
    throw new SubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', 'No subscription found for this user');
  }
  return { subscription: toSubscriptionDTO(subscription) };
}

// ---------------------------------------------------------------------------
// upgradeSubscription — POST /subscriptions/upgrade
// ---------------------------------------------------------------------------

export async function upgradeSubscription(
  user: UserWithRelations,
  body: UpgradeSubscriptionBody,
): Promise<{ subscription: SubscriptionDTO } | { checkoutUrl: string }> {
  const sub = await findSubscriptionByUserId(user.id);
  if (!sub) {
    throw new SubscriptionError(409, 'NO_SUBSCRIPTION_TO_UPGRADE', 'No subscription found. Use POST /subscriptions to activate.');
  }
  if (sub.status.name === 'expired') {
    throw new SubscriptionError(409, 'SUBSCRIPTION_EXPIRED', 'Subscription has expired. Use POST /subscriptions to reactivate.');
  }

  const { billingCycle: requestedBillingCycle } = body;

  // Free → Pro: delegate to checkout
  if (sub.plan.name === 'free') {
    const checkoutUrl = await createProCheckoutSession(user, requestedBillingCycle, body.returnPath);
    return { checkoutUrl };
  }

  // Pro: determine current billing cycle
  const currentBillingCycle = sub.billingCycle!.name as 'monthly' | 'yearly';

  // monthly → yearly: immediate Stripe update
  if (currentBillingCycle === 'monthly' && requestedBillingCycle === 'yearly') {
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
    const itemId = stripeSub.items.data[0]!.id;

    const updatedStripeSub = await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
      items: [{ id: itemId, price: config.STRIPE_PRO_YEARLY_PRICE_ID }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
    });

    const [yearlyCycle, activeStatus] = await Promise.all([
      prisma.billingCycle.findUniqueOrThrow({ where: { name: 'yearly' } }),
      prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
    ]);

    const stripePeriodEnd = (updatedStripeSub as unknown as { current_period_end: number }).current_period_end;
    const stripePeriodStart = (updatedStripeSub as unknown as { current_period_start: number }).current_period_start;
    const updatedSub = await updateSubscriptionById(sub.id, {
      billingCycleId: yearlyCycle.id,
      currentPeriodStart: new Date(stripePeriodStart * 1000),
      currentPeriodEnd: new Date(stripePeriodEnd * 1000),
      scheduledPlanId: null,
      scheduledBillingCycleId: null,
      statusId: activeStatus.id,
    });

    fireEmail(() => sendUpgradeEmail({
      to: user.email,
      fullName: user.fullName,
      newPlan: 'pro',
      newBillingCycle: 'yearly',
    }));

    return { subscription: toSubscriptionDTO(updatedSub) };
  }

  // yearly → monthly: invalid direction (use downgrade)
  if (currentBillingCycle === 'yearly' && requestedBillingCycle === 'monthly') {
    throw new SubscriptionError(400, 'INVALID_UPGRADE', 'To switch from yearly to monthly billing, use POST /subscriptions/downgrade');
  }

  // Same billing cycle: reactivate if pending state exists, else no-op error
  const hasPendingState =
    sub.status.name === 'cancelled' ||
    sub.scheduledPlanId !== null ||
    sub.scheduledBillingCycleId !== null;

  if (hasPendingState) {
    await stripe.subscriptions.update(sub.stripeSubscriptionId!, { cancel_at_period_end: false });
    const activeStatus = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
    const updatedSub = await updateSubscriptionById(sub.id, {
      statusId: activeStatus.id,
      scheduledPlanId: null,
      scheduledBillingCycleId: null,
    });
    return { subscription: toSubscriptionDTO(updatedSub) };
  }

  throw new SubscriptionError(400, 'NO_CHANGE_TO_APPLY', 'The requested billing cycle is already active with no pending changes');
}

// ---------------------------------------------------------------------------
// downgradeSubscription — POST /subscriptions/downgrade
// ---------------------------------------------------------------------------

export async function downgradeSubscription(
  user: UserWithRelations,
  body: DowngradeSubscriptionBody,
): Promise<{ subscription: SubscriptionDTO }> {
  const sub = await findSubscriptionByUserId(user.id);
  if (!sub) {
    throw new SubscriptionError(409, 'NO_SUBSCRIPTION_TO_DOWNGRADE', 'No subscription found. Use POST /subscriptions to activate.');
  }
  if (sub.status.name === 'expired') {
    throw new SubscriptionError(409, 'SUBSCRIPTION_EXPIRED', 'Subscription has expired. Use POST /subscriptions to reactivate.');
  }
  if (sub.scheduledPlanId !== null || sub.scheduledBillingCycleId !== null) {
    throw new SubscriptionError(409, 'DOWNGRADE_ALREADY_SCHEDULED', 'A downgrade is already scheduled. Cancel or upgrade to clear it first.');
  }

  if (body.plan === 'free') {
    if (sub.plan.name === 'free') {
      throw new SubscriptionError(400, 'CANNOT_DOWNGRADE_FROM_FREE', 'Cannot downgrade from the Free plan');
    }

    await stripe.subscriptions.update(sub.stripeSubscriptionId!, { cancel_at_period_end: true });

    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
    const updatedSub = await updateSubscriptionById(sub.id, {
      scheduledPlanId: freePlan.id,
      scheduledBillingCycleId: null,
    });

    fireEmail(() => sendDowngradeScheduledEmail({
      to: user.email,
      fullName: user.fullName,
      scheduledPlan: 'free',
      scheduledBillingCycle: null,
      effectiveDate: sub.currentPeriodEnd ?? new Date(),
    }));

    return { subscription: toSubscriptionDTO(updatedSub) };
  }

  // billingCycle: 'monthly'
  if (sub.plan.name === 'free') {
    throw new SubscriptionError(400, 'CANNOT_DOWNGRADE_FROM_FREE', 'Cannot downgrade from the Free plan');
  }
  if (sub.billingCycle?.name === 'monthly') {
    throw new SubscriptionError(400, 'NO_CHANGE_TO_APPLY', 'Already on monthly billing');
  }

  // yearly → monthly via Subscription Schedule
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: sub.stripeSubscriptionId!,
  });
  await stripe.subscriptionSchedules.update(schedule.id, {
    phases: [
      {
        items: [{ price: config.STRIPE_PRO_YEARLY_PRICE_ID, quantity: 1 }],
        end_date: (stripeSub as unknown as { current_period_end: number }).current_period_end,
      },
      {
        items: [{ price: config.STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 }],
      },
    ],
  });

  const monthlyCycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const updatedSub = await updateSubscriptionById(sub.id, {
    scheduledBillingCycleId: monthlyCycle.id,
  });

  fireEmail(() => sendDowngradeScheduledEmail({
    to: user.email,
    fullName: user.fullName,
    scheduledPlan: null,
    scheduledBillingCycle: 'monthly',
    effectiveDate: sub.currentPeriodEnd ?? new Date(),
  }));

  return { subscription: toSubscriptionDTO(updatedSub) };
}

// ---------------------------------------------------------------------------
// cancelSubscription — POST /subscriptions/cancel
// ---------------------------------------------------------------------------

export async function cancelSubscription(
  user: UserWithRelations,
): Promise<{ subscription: SubscriptionDTO }> {
  const sub = await findSubscriptionByUserId(user.id);
  if (!sub) {
    throw new SubscriptionError(409, 'NO_SUBSCRIPTION_TO_CANCEL', 'No subscription found. Use POST /subscriptions to activate.');
  }
  if (sub.plan.name === 'free') {
    throw new SubscriptionError(400, 'CANNOT_CANCEL_FREE', 'Free plan subscriptions cannot be cancelled. See account deletion for full removal.');
  }
  if (sub.status.name === 'expired') {
    throw new SubscriptionError(409, 'SUBSCRIPTION_EXPIRED', 'Subscription has already expired.');
  }

  // Idempotent: already cancelled
  if (sub.status.name === 'cancelled') {
    return { subscription: toSubscriptionDTO(sub) };
  }

  await stripe.subscriptions.update(sub.stripeSubscriptionId!, { cancel_at_period_end: true });

  const cancelledStatus = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'cancelled' } });
  const updatedSub = await updateSubscriptionById(sub.id, {
    statusId: cancelledStatus.id,
  });

  fireEmail(() => sendCancellationScheduledEmail({
    to: user.email,
    fullName: user.fullName,
    effectiveDate: sub.currentPeriodEnd ?? new Date(),
  }));

  return { subscription: toSubscriptionDTO(updatedSub) };
}

// ---------------------------------------------------------------------------
// refundSubscription — POST /subscriptions/refund
// ---------------------------------------------------------------------------

export async function refundSubscription(
  user: UserWithRelations,
  body: RefundSubscriptionBody,
): Promise<{ refundRequested: boolean; paymentId: number }> {
  const sub = await findSubscriptionByUserId(user.id);
  if (!sub) {
    throw new SubscriptionError(409, 'NO_SUBSCRIPTION_TO_REFUND', 'No subscription found for this user');
  }

  const succeededStatus = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'succeeded' } });
  const payment = await prisma.payment.findFirst({
    where: { userId: user.id, statusId: succeededStatus.id },
    orderBy: { createdAt: 'desc' },
    include: { status: true },
  });
  if (!payment) {
    throw new SubscriptionError(409, 'NO_PAYMENT_TO_REFUND', 'No successful payment found to refund');
  }

  const eligible =
    payment.refundAvailable &&
    payment.status.name === 'succeeded' &&
    Date.now() - payment.createdAt.getTime() <= REFUND_WINDOW_MS;

  if (!eligible) {
    throw new SubscriptionError(400, 'REFUND_NOT_ELIGIBLE', 'This payment is not eligible for refund');
  }

  // --- Concurrency safety (audit decision 2) ---
  // 1) Redis SET NX cooldown so two in-flight requests can't both reach Stripe.
  const lockKey = `refund:${payment.id}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 120, 'NX');
  if (acquired !== 'OK') {
    throw new SubscriptionError(409, 'REFUND_IN_PROGRESS', 'A refund for this payment is already being processed');
  }

  try {
    // 2) Flip refundAvailable=false BEFORE the Stripe call, atomically (compare-and-set on the
    //    refundAvailable:true guard) so a racing request that slipped past the eligibility read
    //    can't double-refund.
    const flipped = await prisma.payment.updateMany({
      where: { id: payment.id, refundAvailable: true },
      data: { refundAvailable: false },
    });
    if (flipped.count === 0) {
      throw new SubscriptionError(409, 'REFUND_IN_PROGRESS', 'A refund for this payment is already being processed');
    }

    // 3) Create the Stripe refund with a per-payment idempotency key so a retry of THIS request
    //    never issues a second refund.
    const refundParams: Parameters<typeof stripe.refunds.create>[0] = {
      payment_intent: payment.stripePaymentIntentId,
    };
    if (body.reason) {
      refundParams.reason = 'requested_by_customer';
      refundParams.metadata = { user_reason: body.reason.slice(0, 500) };
    }

    try {
      await stripe.refunds.create(refundParams, { idempotencyKey: `refund:${payment.id}` });
    } catch (e: unknown) {
      // Stripe failed — RESTORE the flag so a transient failure doesn't permanently block a legit
      // refund, then surface the error.
      await prisma.payment
        .update({ where: { id: payment.id }, data: { refundAvailable: true } })
        .catch(() => undefined);
      const code = (e as { code?: string }).code ?? 'unknown';
      throw new SubscriptionError(400, 'REFUND_FAILED', 'Refund request failed', { stripeCode: code });
    }

    // 4) Revoke Pro AT PERIOD END (audit decision 2): cancel the Stripe subscription at period end
    //    and schedule the local downgrade to Free. The user keeps Pro until the paid period
    //    expires, then the existing customer.subscription.deleted webhook applies the downgrade.
    //    The refund already succeeded, so a failure here must NOT 500 the request — log + continue
    //    (the charge.refunded webhook still marks the payment refunded; reconcile out-of-band).
    if (sub.stripeSubscriptionId && sub.plan.name !== 'free') {
      try {
        await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
        const freePlan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
        await updateSubscriptionById(sub.id, { scheduledPlanId: freePlan.id, scheduledBillingCycleId: null });
      } catch (e) {
        console.error(
          '[subscriptions] refund succeeded but scheduling period-end downgrade failed',
          e instanceof Error ? e.message : e,
        );
      }
    }

    return { refundRequested: true, paymentId: payment.id };
  } finally {
    await redis.del(lockKey).catch(() => undefined);
  }
}
