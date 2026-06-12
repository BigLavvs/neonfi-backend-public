import { z } from 'zod';

export const ListPaymentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
});

export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;
