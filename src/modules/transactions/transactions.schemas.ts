import { z } from 'zod';

const directionEnum = z.enum(['buy', 'sell', 'transfer']);

const decimalStr = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

const commonFields = {
  direction: directionEnum,
  timestamp: z.string().datetime({ message: 'timestamp must be an ISO 8601 datetime string' }),
  transactionHash: z.string().max(255).optional(),
  from: z.string().max(255).nullable().optional(),
  to: z.string().max(255).nullable().optional(),
  gasFee: decimalStr.nullable().optional(),
  // retrofit-7: optional free-text note (frontend AddTransactionModal). On all types.
  notes: z.string().max(2000).nullable().optional(),
};

const NativeTransactionSchema = z
  .object({
    type: z.literal('native'),
    amount: decimalStr,
    symbol: z.string().min(1).max(20),
    // retrofit-7: user-entered price override → drives usdValue (manual cost basis).
    priceAtTime: decimalStr.optional(),
    ...commonFields,
  })
  .strict();

const Erc20TransactionSchema = z
  .object({
    type: z.literal('erc20'),
    amount: decimalStr,
    symbol: z.string().min(1).max(20),
    tokenContractAddress: z.string().min(1).max(255),
    tokenName: z.string().min(1).max(255),
    tokenSymbol: z.string().min(1).max(20),
    // retrofit-7: user-entered price override → drives usdValue (manual cost basis).
    priceAtTime: decimalStr.optional(),
    ...commonFields,
  })
  .strict();

const NftTransactionSchema = z
  .object({
    type: z.literal('nft'),
    tokenContractAddress: z.string().min(1).max(255),
    nftTokenId: z.string().min(1).max(255),
    nftName: z.string().max(255).optional(),
    collectionName: z.string().max(255).optional(),
    ...commonFields,
  })
  .strict();

export const CreateTransactionBodySchema = z.discriminatedUnion('type', [
  NativeTransactionSchema,
  Erc20TransactionSchema,
  NftTransactionSchema,
]);

export type CreateTransactionBody = z.infer<typeof CreateTransactionBodySchema>;
export type NativeTransactionBody = z.infer<typeof NativeTransactionSchema>;
export type Erc20TransactionBody = z.infer<typeof Erc20TransactionSchema>;
export type NftTransactionBody = z.infer<typeof NftTransactionSchema>;

export const UpdateTransactionBodySchema = z
  .object({
    direction: directionEnum.optional(),
    from: z.string().max(255).nullable().optional(),
    to: z.string().max(255).nullable().optional(),
    gasFee: decimalStr.nullable().optional(),
    timestamp: z.string().datetime({ message: 'timestamp must be an ISO 8601 datetime string' }).optional(),
    amount: decimalStr.optional(),
    symbol: z.string().min(1).max(20).optional(),
    tokenContractAddress: z.string().max(255).optional(),
    tokenName: z.string().max(255).optional(),
    tokenSymbol: z.string().max(20).optional(),
    nftName: z.string().max(255).nullable().optional(),
    nftTokenId: z.string().max(255).optional(),
    collectionName: z.string().max(255).nullable().optional(),
    // retrofit-7: priceAtTime override (native/erc20 only) + free-text note.
    priceAtTime: decimalStr.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type UpdateTransactionBody = z.infer<typeof UpdateTransactionBodySchema>;
