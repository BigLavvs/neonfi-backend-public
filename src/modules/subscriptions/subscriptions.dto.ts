// Neonfi backend — Subscriptions module: DTO mapper (Stage 3A).
//
// toSubscriptionDTO resolves lookup-table FKs to their string names.
// The raw planId/billingCycleId/statusId are never exposed.

import type { Prisma } from '@prisma/client';

export type SubscriptionWithRelations = Prisma.SubscriptionGetPayload<{
  include: { plan: true; billingCycle: true; status: true };
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
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}
