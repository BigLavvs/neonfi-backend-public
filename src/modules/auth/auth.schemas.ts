// Neonfi backend — Auth module: Zod request schemas (Stage 1A).
//
// Password policy §1.5: min 8 chars, at least one letter + one number, max 128 chars.
// Email is lowercased at parse time (transform) so all downstream code receives
// a normalised email and never has to remember to lowercase it.

import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => /[a-zA-Z]/.test(p), 'Password must contain at least one letter')
  .refine((p) => /[0-9]/.test(p), 'Password must contain at least one number');

export const RegisterSchema = z.object({
  email: z.string().email('Invalid email address').transform((e) => e.toLowerCase()),
  password: passwordSchema,
  fullName: z.string().min(1, 'Full name is required').max(255, 'Full name is too long'),
  displayName: z.string().min(1).max(100, 'Display name is too long').optional(),
});

export const LoginSchema = z.object({
  email: z.string().email('Invalid email address').transform((e) => e.toLowerCase()),
  password: z.string().min(1, 'Password is required'),
});

export const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export const ResendVerificationSchema = z.object({
  email: z.string().email('Invalid email address').transform((e) => e.toLowerCase()),
});

export type RegisterBody = z.infer<typeof RegisterSchema>;
export type LoginBody = z.infer<typeof LoginSchema>;
export type VerifyEmailBody = z.infer<typeof VerifyEmailSchema>;
export type ResendVerificationBody = z.infer<typeof ResendVerificationSchema>;
