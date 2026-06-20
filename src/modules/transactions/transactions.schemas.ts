import { z } from 'zod';

const directionEnum = z.enum(['buy', 'sell', 'transfer']);

const decimalStr = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

// retrofit-73 (R44): Decimal(20,8) holds 12 integer digits, so the magnitude must stay below
// 10^12. An over-large amount used to overflow the column and surface as a 500; bounding it here
// returns a clean 400 VALIDATION_ERROR instead. Applies to every decimal that reaches a
// Decimal(20,8) column (amount, gasFee, priceAtTime).
const MAX_DECIMAL = 1e12;
const boundedDecimalStr = decimalStr.refine(
  (v) => Number(v) < MAX_DECIMAL,
  `value must be less than ${MAX_DECIMAL}`,
);

// retrofit-73 (R43): a tradeable amount must be strictly positive — 0 (and the regex already
// blocks negatives) was being accepted and created a $0 transaction.
const amountStr = boundedDecimalStr.refine((v) => Number(v) > 0, 'amount must be greater than 0');

// retrofit-73 (R45): reject future-dated transactions (with a small clock-skew tolerance). A
// 2099 date corrupts the value-history reconstruction and the chart x-axis.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const notFutureTimestamp = z
  .string()
  .datetime({ message: 'timestamp must be an ISO 8601 datetime string' })
  .refine((v) => Date.parse(v) <= Date.now() + CLOCK_SKEW_MS, 'timestamp must not be in the future');

const commonFields = {
  direction: directionEnum,
  timestamp: notFutureTimestamp,
  transactionHash: z.string().max(255).optional(),
  from: z.string().max(255).nullable().optional(),
  to: z.string().max(255).nullable().optional(),
  gasFee: boundedDecimalStr.nullable().optional(),
  // retrofit-7: optional free-text note (frontend AddTransactionModal). On all types.
  notes: z.string().max(2000).nullable().optional(),
};

const NativeTransactionSchema = z
  .object({
    type: z.literal('native'),
    amount: amountStr,
    symbol: z.string().min(1).max(20),
    // retrofit-7: user-entered price override → drives usdValue (manual cost basis).
    priceAtTime: boundedDecimalStr.optional(),
    ...commonFields,
  })
  .strict();

const Erc20TransactionSchema = z
  .object({
    type: z.literal('erc20'),
    amount: amountStr,
    symbol: z.string().min(1).max(20),
    tokenContractAddress: z.string().min(1).max(255),
    tokenName: z.string().min(1).max(255),
    tokenSymbol: z.string().min(1).max(20),
    // retrofit-7: user-entered price override → drives usdValue (manual cost basis).
    priceAtTime: boundedDecimalStr.optional(),
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
    gasFee: boundedDecimalStr.nullable().optional(),
    timestamp: notFutureTimestamp.optional(),
    amount: amountStr.optional(),
    symbol: z.string().min(1).max(20).optional(),
    tokenContractAddress: z.string().max(255).optional(),
    tokenName: z.string().max(255).optional(),
    tokenSymbol: z.string().max(20).optional(),
    nftName: z.string().max(255).nullable().optional(),
    nftTokenId: z.string().max(255).optional(),
    collectionName: z.string().max(255).nullable().optional(),
    // retrofit-7: priceAtTime override (native/erc20 only) + free-text note.
    priceAtTime: boundedDecimalStr.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type UpdateTransactionBody = z.infer<typeof UpdateTransactionBodySchema>;

// retrofit-10 (C4b): cross-portfolio transfer. Moves `amount` of `symbol` from the
// source portfolio (the URL :portfolioId) to `destPortfolioId` as a paired sell+buy.
// Both portfolios must be manual and owned by the caller; dest must differ from source.
// Manual transfer legs are always `native` (the Token catalog carries no contract
// address — same constraint as seedAcquisitionInTx), so no token-contract fields here.
export const TransferBodySchema = z
  .object({
    destPortfolioId: z.number().int().positive(),
    symbol: z.string().min(1).max(20),
    amount: amountStr,
    timestamp: notFutureTimestamp.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type TransferBody = z.infer<typeof TransferBodySchema>;

// retrofit-87: CSV bulk import. The ENVELOPE is validated here (mode + rows-is-array); each
// row stays a loose object so a single bad cell becomes a precise per-row error instead of
// collapsing the whole request to one VALIDATION_ERROR. The row cap (TOO_MANY_ROWS) and the
// per-row parity check (each row is re-parsed through CreateTransactionBodySchema as a native
// transaction) live in the bulk service, not here.
export const BulkTransactionsBodySchema = z
  .object({
    mode: z.enum(['all_or_nothing', 'skip_invalid']),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

export type BulkTransactionsBody = z.infer<typeof BulkTransactionsBodySchema>;
