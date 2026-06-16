import { z } from 'zod';

export const ListTokensQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().min(1).max(100).optional(),
});

export type ListTokensQuery = z.infer<typeof ListTokensQuerySchema>;

// retrofit-21: GET /tokens/:id/history?days=N. `days` is the look-back window for the
// price chart. Coerced int, then CLAMPED into [1, 3650] (≈10y) — clamped, not rejected,
// so 0 → 1 and 99999 → 3650 rather than 400-ing the chart. `.catch(365)` swallows a
// malformed/missing value (undefined coerces to NaN → fails → 365) so the chart always
// gets a usable window. Default look-back is 365 days.
export const TokenHistoryQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .catch(365)
    .transform((n) => Math.min(3650, Math.max(1, n))),
});

export type TokenHistoryQuery = z.infer<typeof TokenHistoryQuerySchema>;
