// Neonfi backend — Subscriptions module: service layer (Stage 3A).
//
// Two paths:
//   Free  — synchronous: creates Subscription row + transitions onboarding to
//           'complete' in one transaction, then sends confirmation email async.
//   Pro   — returns a Stripe Checkout URL only; no Subscription row created here.
//           The Stage 4 webhook creates the row on confirmed payment.
//
// Gate: onboardingStatus must be 'verified'. Any other status → 403 or 409.

import { prisma } from '../../lib/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { config } from '../../lib/config.js';
import { createFreeSubscription, findSubscriptionByUserId } from './subscriptions.repository.js';
import { toSubscriptionDTO, type SubscriptionDTO } from './subscriptions.dto.js';
import { transitionToCompleteOnboarding } from '../users/users.repository.js';
import { sendSubscriptionConfirmationEmail } from '../email/email.service.js';
import type { UserWithRelations } from '../users/users.repository.js';
import type { CreateSubscriptionBody } from './subscriptions.schemas.js';

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

export class SubscriptionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

// ---------------------------------------------------------------------------
// activateSubscription — POST /subscriptions
// ---------------------------------------------------------------------------

export async function activateSubscription(
  user: UserWithRelations,
  body: CreateSubscriptionBody,
): Promise<{ subscription: SubscriptionDTO } | { checkoutUrl: string }> {
  // Gate: onboarding status check
  const statusName = user.onboardingStatus.name;
  if (statusName === 'pending_verification') {
    throw new SubscriptionError(403, 'EMAIL_NOT_VERIFIED', 'Email must be verified before activating a subscription');
  }
  if (statusName === 'plan_selected' || statusName === 'complete') {
    throw new SubscriptionError(409, 'SUBSCRIPTION_ALREADY_ACTIVATED', 'Subscription is already activated');
  }

  if (body.plan === 'free') {
    // Atomic: create subscription + transition onboarding to 'complete'
    const subscription = await prisma.$transaction(async (tx) => {
      const sub = await createFreeSubscription(user.id, tx);
      await transitionToCompleteOnboarding(user.id, tx);
      return sub;
    });

    // Fire-and-forget: send confirmation email after commit
    void (async () => {
      try {
        await sendSubscriptionConfirmationEmail({
          to: user.email,
          fullName: user.fullName,
          plan: 'free',
        });
      } catch (e) {
        console.error('[subscriptions] post-activation email failed', e instanceof Error ? e.message : e);
      }
    })();

    return { subscription: toSubscriptionDTO(subscription) };
  }

  // Pro path: create Stripe Checkout Session — no DB writes
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{
      price: body.billingCycle === 'monthly'
        ? config.STRIPE_PRO_MONTHLY_PRICE_ID
        : config.STRIPE_PRO_YEARLY_PRICE_ID,
      quantity: 1,
    }],
    customer_email: user.email,
    client_reference_id: String(user.id),
    metadata: {
      userId: String(user.id),
      plan: 'pro',
      billingCycle: body.billingCycle!,
    },
    success_url: `${config.APP_BASE_URL}/onboarding?subscription=activated`,
    cancel_url: `${config.APP_BASE_URL}/onboarding?subscription=cancelled`,
  });

  if (!session.url) {
    throw new SubscriptionError(500, 'STRIPE_ERROR', 'Failed to create Stripe Checkout Session');
  }

  return { checkoutUrl: session.url };
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
