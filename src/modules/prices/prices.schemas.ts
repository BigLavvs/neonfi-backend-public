import { z } from 'zod';

export const refreshBodySchema = z.object({
  symbols: z
    .array(z.string().min(1).toUpperCase())
    .max(5, 'Maximum 5 symbols per refresh call')
    .optional(),
});

export type RefreshBody = z.infer<typeof refreshBodySchema>;
