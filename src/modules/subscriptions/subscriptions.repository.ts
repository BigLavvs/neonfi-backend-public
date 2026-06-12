// Neonfi backend — Subscriptions module: data-access layer (Stage 3A/3B).
//
// All DB queries for the Subscription table go through this file.
// The free-activation path calls createFreeSubscription inside a transaction;
// the tx parameter threads the Prisma transaction client through.

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { SubscriptionWithRelations } from './subscriptions.dto.js';

const SUBSCRIPTION_INCLUDE = {
  include: {
    plan: true,
    billingCycle: true,
    status: true,
    scheduledPlan: true,
    scheduledBillingCycle: true,
  },
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
  // Lookups use the main prisma client — static seed data, safe outside tx.
  const [plan, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  const client = tx ?? prisma;
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

export async function updateSubscriptionById(
  id: number,
  data: Prisma.SubscriptionUncheckedUpdateInput,
): Promise<SubscriptionWithRelations> {
  return prisma.subscription.update({
    where: { id },
    data,
    ...SUBSCRIPTION_INCLUDE,
  });
}

export async function upsertSubscriptionFromCheckout(params: {
  userId: number;
  billingCycle: 'monthly' | 'yearly';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  tx?: Prisma.TransactionClient;
}): Promise<SubscriptionWithRelations> {
  const { userId, billingCycle, stripeCustomerId, stripeSubscriptionId, currentPeriodStart, currentPeriodEnd, tx } = params;
  // Lookups use the main prisma client — static seed data, safe outside tx.
  const [proPlan, billingCycleRow, activeStatus] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: billingCycle } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  const client = tx ?? prisma;

  return client.subscription.upsert({
    where: { userId },
    update: {
      planId: proPlan.id,
      billingCycleId: billingCycleRow.id,
      statusId: activeStatus.id,
      stripeCustomerId,
      stripeSubscriptionId,
      currentPeriodStart,
      currentPeriodEnd,
      scheduledPlanId: null,
      scheduledBillingCycleId: null,
    },
    create: {
      userId,
      planId: proPlan.id,
      billingCycleId: billingCycleRow.id,
      statusId: activeStatus.id,
      stripeCustomerId,
      stripeSubscriptionId,
      currentPeriodStart,
      currentPeriodEnd,
    },
    ...SUBSCRIPTION_INCLUDE,
  });
}

export async function applyScheduledDowngrade(
  subscriptionId: number,
  tx?: Prisma.TransactionClient,
): Promise<SubscriptionWithRelations> {
  // Lookups use the main prisma client — static seed data, safe outside tx.
  const [freePlan, activeStatus] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  const client = tx ?? prisma;
  return client.subscription.update({
    where: { id: subscriptionId },
    data: {
      planId: freePlan.id,
      billingCycleId: null,
      statusId: activeStatus.id,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      scheduledPlanId: null,
      scheduledBillingCycleId: null,
    },
    ...SUBSCRIPTION_INCLUDE,
  });
}
