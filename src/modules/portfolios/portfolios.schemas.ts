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
