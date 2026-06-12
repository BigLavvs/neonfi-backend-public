// Neonfi backend — Subscriptions module: data-access layer (Stage 3A).
//
// All DB queries for the Subscription table go through this file.
// The free-activation path calls createFreeSubscription inside a transaction;
// the tx parameter threads the Prisma transaction client through.

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { SubscriptionWithRelations } from './subscriptions.dto.js';

const SUBSCRIPTION_INCLUDE = {
  include: { plan: true, billingCycle: true, status: true },
} as const satisfies Prisma.SubscriptionDefaultArgs;

export async function findSubscriptionByUserId(
  userId: number,
): Promise<SubscriptionWithRelations | null> {
  return prisma.subscription.findUnique({
    where: { userId },
    ...SUBSCRIPTION_INCLUDE,
  });
}

export async function createFreeSubscription(
  userId: number,
  tx?: Prisma.TransactionClient,
): Promise<SubscriptionWithRelations> {
  const client = tx ?? prisma;
  const [plan, status] = await Promise.all([
    client.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    client.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  return client.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: null,
      statusId: status.id,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    },
    ...SUBSCRIPTION_INCLUDE,
  });
}
