// Neonfi backend — Auth module: plan-based access control (Stage 3B activation).
//
// Checks the user's active subscription plan. Must run after requireAuth.
// Attaches the subscription to context so downstream handlers can read it
// without an additional DB round-trip.
//
// Treats cancelled-but-in-period subscriptions as effectively active per
// Build Guide §4.7: "subscription still functions as Pro until currentPeriodEnd".

import type { Context, Next, MiddlewareHandler } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { err } from '../../lib/envelope.js';
import type { AuthEnv } from './middleware.js';
import { isSubscriptionEffectivelyActive } from '../subscriptions/subscription-status.js';

export const requirePlan =
  (allowed: Array<'free' | 'pro'>): MiddlewareHandler<AuthEnv> =>
  async (c: Context<AuthEnv>, next: Next) => {
    const user = c.get('user');

    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      include: {
        plan: true,
        billingCycle: true,
        status: true,
        scheduledPlan: true,
        scheduledBillingCycle: true,
      },
    });

    if (!subscription) {
      return c.json(err('SUBSCRIPTION_REQUIRED', 'Activate a subscription to access this resource'), 403);
    }

    const effectivelyActive = isSubscriptionEffectivelyActive(subscription);

    if (!effectivelyActive) {
      return c.json(err('SUBSCRIPTION_EXPIRED', 'Subscription is no longer active'), 403);
    }

    const userPlan = subscription.plan.name as 'free' | 'pro';
    if (!allowed.includes(userPlan)) {
      return c.json(
        err('PLAN_LIMIT_REACHED', `This resource requires one of: ${allowed.join(', ')}`),
        403,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set('subscription', subscription as any);
    await next();
  };
