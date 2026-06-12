// Neonfi backend — Subscriptions module: DTO mapper (Stage 3A/3B).
//
// toSubscriptionDTO resolves lookup-table FKs to their string names.
// The raw planId/billingCycleId/statusId/scheduledPlanId/scheduledBillingCycleId
// are never exposed in the DTO.

import type { Prisma } from '@prisma/client';

export type SubscriptionWithRelations = Prisma.SubscriptionGetPayload<{
  include: {
    plan: true;
    billingCycle: true;
    status: true;
    scheduledPlan: true;
    scheduledBillingCycle: true;
  };
}>;

export interface SubscriptionDTO {
  id: number;
  userId: number;
  plan: string;
  billingCycle: string | null;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  scheduledPlan: string | null;
  scheduledBillingCycle: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toSubscriptionDTO(sub: SubscriptionWithRelations): SubscriptionDTO {
  return {
    id: sub.id,
    userId: sub.userId,
    plan: sub.plan.name,
    billingCycle: sub.billingCycle?.name ?? null,
    status: sub.status.name,
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    scheduledPlan: sub.scheduledPlan?.name ?? null,
    scheduledBillingCycle: sub.scheduledBillingCycle?.name ?? null,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}
