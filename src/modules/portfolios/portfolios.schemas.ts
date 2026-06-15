import { z } from 'zod';

const ConnectedPortfolioSchema = z.object({
  type: z.literal('connected'),
  name: z.string().min(1).max(255),
  walletAddress: z.string().min(1),
  chainId: z.number().int().positive(),
}).strict();

const ManualPortfolioSchema = z.object({
  type: z.literal('manual'),
  name: z.string().min(1).max(255),
  startingBalance: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  // retrofit-8: atomic manual portfolio creation with an initial holdings list. Each
  // entry optionally carries an acquisition (amount + priceAtTime + timestamp + notes)
  // that seeds a native `buy` tx — same model as POST /portfolios/:id/assets. Capped at
  // 50 to bound the per-create $transaction (Neon P2028 guard, §6.3). Frontend sends
  // either startingBalance OR assets[]; if both arrive, the seeds' Σ cost-basis wins.
  assets: z.array(z.object({
    tokenId: z.number().int().positive(),
    amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    priceAtTime: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    timestamp: z.string().datetime().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }).strict()).max(50).optional(),
}).strict();

export const CreatePortfolioBodySchema = z.discriminatedUnion('type', [
  ConnectedPortfolioSchema,
  ManualPortfolioSchema,
]);

export type CreatePortfolioBody = z.infer<typeof CreatePortfolioBodySchema>;

export const ListPortfoliosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPortfoliosQuery = z.infer<typeof ListPortfoliosQuerySchema>;

export const UpdatePortfolioBodySchema = z.object({
  name: z.string().min(1).max(255),
}).strict();

export type UpdatePortfolioBody = z.infer<typeof UpdatePortfolioBodySchema>;
