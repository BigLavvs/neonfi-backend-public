import { z } from 'zod';

export const refreshBodySchema = z.object({
  symbols: z
    .array(z.string().min(1).toUpperCase())
    .max(5, 'Maximum 5 symbols per refresh call')
    .optional(),
});

export type RefreshBody = z.infer<typeof refreshBodySchema>;

// retrofit-43: GET /prices/history?symbols=BTC,ETH&range=1H query.
// retrofit-46: range widened to daily windows (1W/1M/1Y/ALL) so the frontend has a single
// "price-at-time per symbol" source at any range — 1H/1D still serve the Redis buffer; the
// daily windows serve the TokenPriceSnapshot daily-close series.
export const historyQuerySchema = z.object({
  // comma-separated, case-insensitive; deduped + capped to 50 to bound the LRANGE fan-out
  symbols: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))].slice(0, 50)),
  range: z.enum(['1H', '1D', '1W', '1M', '1Y', 'ALL']).default('1H'),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryRange = HistoryQuery['range'];
