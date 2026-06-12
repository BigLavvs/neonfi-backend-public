// Neonfi backend — Subscriptions module: Zod request schemas (Stage 3A).
//
// billingCycle REQUIRED for pro, FORBIDDEN for free — enforced via .refine().

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
