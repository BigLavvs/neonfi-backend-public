import { z } from 'zod';

// retrofit-8: asset-add optionally seeds an acquisition. When `amount` is present
// (> 0) the create also logs a native `buy` transaction so balance/cost-basis derive
// from one source of truth (recalc.ts). Omitting `amount` keeps the back-compat
// `{tokenId}`-only path (asset at balance 0). priceAtTime/timestamp/notes mirror the
// manual-transaction fields (retrofit-7); `.strict()` so `balance` etc. stay rejected.
export const CreateAssetBodySchema = z.object({
  tokenId: z.number().int().positive(),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  priceAtTime: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  timestamp: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict();

export const UpdateAssetBodySchema = z.object({
  netDeposit: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'netDeposit must be a non-negative decimal string')
    .optional(),
}).strict();

export type CreateAssetBody = z.infer<typeof CreateAssetBodySchema>;
export type UpdateAssetBody = z.infer<typeof UpdateAssetBodySchema>;
