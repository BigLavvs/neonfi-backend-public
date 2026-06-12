import { z } from 'zod';

export const ListTokensQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().min(1).max(100).optional(),
});

export type ListTokensQuery = z.infer<typeof ListTokensQuerySchema>;
