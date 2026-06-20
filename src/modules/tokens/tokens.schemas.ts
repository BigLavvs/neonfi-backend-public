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

// retrofit-87: POST /tokens/validate-symbols — the CSV-import preview asks which symbols
// don't resolve, WITHOUT shipping the whole catalog to the client. Cap the array at 1000
// (Zod rejects beyond → 400) so a pathological upload can't fan out an unbounded `IN` query;
// blanks/dupes/casing are normalized in the service.
export const ValidateSymbolsBodySchema = z
  .object({
    symbols: z.array(z.string().max(255)).max(1000, 'at most 1000 symbols per request'),
  })
  .strict();

export type ValidateSymbolsBody = z.infer<typeof ValidateSymbolsBodySchema>;
