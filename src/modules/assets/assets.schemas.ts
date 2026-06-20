import { z } from 'zod';

const decimalStr = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

// retrofit-27 §5: POST /portfolios/:id/assets now creates an OPENING position (a
// pre-existing holding that is NOT a trade), not a seed-a-buy. Body is
// `{ tokenId, balance(>0), cost }` where cost selects how the opening basis is set:
//   - avg        → openingCostBasis = balance × avgCost
//   - historical → price = nearest TokenPriceSnapshot on/before `date` (400 if none)
//   - none       → openingCostBasis = null (cost-unknown; excluded from avg-cost PnL)
// Acquisitions AFTER opening go through New Transaction → Buy (which auto-creates the
// asset, §6), so the old amount/priceAtTime seed-a-buy params are gone. balance > 0 is
// enforced in the service (regex can't express it). `.strict()` rejects stray fields.
const CostAvgSchema = z.object({ mode: z.literal('avg'), avgCost: decimalStr }).strict();
const CostHistoricalSchema = z
  .object({
    mode: z.literal('historical'),
    date: z.string().datetime({ message: 'cost.date must be an ISO 8601 datetime string' }),
  })
  .strict();
const CostNoneSchema = z.object({ mode: z.literal('none') }).strict();

export const CostSchema = z.discriminatedUnion('mode', [
  CostAvgSchema,
  CostHistoricalSchema,
  CostNoneSchema,
]);

export const CreateAssetBodySchema = z
  .object({
    tokenId: z.number().int().positive(),
    balance: decimalStr,
    cost: CostSchema,
  })
  .strict();

// retrofit-44: opening edit — balance/cost edit the opening position in place; netDeposit
// kept for back-compat. Refine requires at least one field so empty bodies are rejected.
export const UpdateAssetBodySchema = z
  .object({
    netDeposit: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'netDeposit must be a non-negative decimal string')
      .optional(),
    balance: decimalStr.optional(),
    cost: CostSchema.optional(),
  })
  .strict()
  .refine((b) => b.netDeposit !== undefined || b.balance !== undefined || b.cost !== undefined, {
    message: 'Provide netDeposit, or balance/cost to edit the opening position',
  });

export type CreateAssetBody = z.infer<typeof CreateAssetBodySchema>;
export type UpdateAssetBody = z.infer<typeof UpdateAssetBodySchema>;

// retrofit-87: CSV bulk import of STARTING ASSETS. Envelope only (mode + rows-is-array); each
// row stays a loose object so a bad cell becomes a precise per-row error rather than failing the
// whole request. The row cap (TOO_MANY_ROWS), the cost-mode derivation, and the per-row parity
// check (each row is re-parsed through CreateAssetBodySchema) live in the bulk service.
export const BulkAssetsBodySchema = z
  .object({
    mode: z.enum(['all_or_nothing', 'skip_invalid']),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

export type BulkAssetsBody = z.infer<typeof BulkAssetsBodySchema>;
