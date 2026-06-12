// Neonfi backend — Subscriptions module: Zod request schemas (Stage 3A/3B).

import { z } from 'zod';

export const CreateSubscriptionSchema = z
  .object({
    plan: z.enum(['free', 'pro']),
    billingCycle: z.enum(['monthly', 'yearly']).optional(),
  })
  .strict()
  .refine(
    (data) => !(data.plan === 'pro' && data.billingCycle === undefined),
    { message: 'billingCycle is required for the pro plan', path: ['billingCycle'] },
  )
  .refine(
    (data) => !(data.plan === 'free' && data.billingCycle !== undefined),
    { message: 'billingCycle is not allowed for the free plan', path: ['billingCycle'] },
  );

export type CreateSubscriptionBody = z.infer<typeof CreateSubscriptionSchema>;

export const UpgradeSubscriptionSchema = z
  .object({
    billingCycle: z.enum(['monthly', 'yearly']),
  })
  .strict();

export type UpgradeSubscriptionBody = z.infer<typeof UpgradeSubscriptionSchema>;

export const DowngradeSubscriptionSchema = z
  .object({
    plan: z.literal('free').optional(),
    billingCycle: z.literal('monthly').optional(),
  })
  .strict()
  .refine(
    (data) => (data.plan !== undefined) !== (data.billingCycle !== undefined),
    { message: 'Exactly one of plan or billingCycle must be provided' },
  );

export type DowngradeSubscriptionBody = z.infer<typeof DowngradeSubscriptionSchema>;
