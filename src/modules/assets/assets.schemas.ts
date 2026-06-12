import { z } from 'zod';

export const CreateAssetBodySchema = z.object({
  tokenId: z.number().int().positive(),
}).strict();

export const UpdateAssetBodySchema = z.object({
  netDeposit: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'netDeposit must be a non-negative decimal string')
    .optional(),
}).strict();

export type CreateAssetBody = z.infer<typeof CreateAssetBodySchema>;
export type UpdateAssetBody = z.infer<typeof UpdateAssetBodySchema>;
