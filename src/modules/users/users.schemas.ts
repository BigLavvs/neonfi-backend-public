// Neonfi backend — Users module: Zod request schemas (Stage 2).
//
// PatchMeSchema uses .strict() so any field not listed here is immediately
// rejected with 400 VALIDATION_ERROR. Fields that are server-managed and
// must NOT be accepted from clients:
//   email             — change requires re-verification + session re-issue (doc-fix item)
//   password          — change is deferred (see stage-2.md §1.1)
//   avatarUrl         — server-managed via POST/DELETE /users/me/avatar only (retrofit-90);
//                       a client must never set an arbitrary avatar URL here (audit SEC #4/#23)
//   plan/billingCycle — server-managed via Subscription (Stage 3)
//   onboardingStatus  — server-managed lifecycle
//   authProvider      — immutable after registration
//   id/createdAt/updatedAt/passwordHash — never client-settable

import { z } from 'zod';

export const PatchMeSchema = z
  .object({
    fullName: z.string().min(1, 'Full name cannot be empty').max(255).optional(),
    displayName: z
      .string()
      .min(1, 'Use null to clear display name')
      .max(100)
      .nullable()
      .optional(),
    newsletterSubscribed: z.boolean().optional(),
  })
  .strict(); // unknown fields (incl. avatarUrl) → 400 VALIDATION_ERROR

export type PatchMeBody = z.infer<typeof PatchMeSchema>;

// ---------------------------------------------------------------------------
// PatchPreferencesSchema — PATCH /users/preferences (settings Preferences tab).
// Dedicated to notification/display preferences; kept separate from PatchMeSchema
// (profile) because the frontend calls a distinct /users/preferences endpoint.
// baseCurrency enum matches the frontend settings currency selector.
// ---------------------------------------------------------------------------

export const PatchPreferencesSchema = z
  .object({
    newsletterSubscribed: z.boolean().optional(),
    priceAlertsEnabled: z.boolean().optional(),
    pushEnabled: z.boolean().optional(),
    baseCurrency: z.enum(['USD', 'EUR', 'GBP', 'JPY', 'NGN']).optional(),
  })
  .strict(); // unknown fields → 400 VALIDATION_ERROR

export type PatchPreferencesBody = z.infer<typeof PatchPreferencesSchema>;
