import type { Prisma } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import type { TransactionWithAllRelations, TransactionWithListIncludes } from './transactions.dto.js';

// The $extends'd client's interactive-tx type (see prisma.ts) — not Prisma.TransactionClient.
type TxClient = PrismaTransactionClient;

const DETAIL_INCLUDE = {
  type: true,
  direction: true,
  nativeDetail: true,
  erc20Detail: true,
  nftDetail: true,
} as const;

// retrofit-2: list now pulls native/erc20 detail so the response surfaces
// amount/symbol/usdValue flat per row. nftDetail intentionally excluded.
const LIST_INCLUDE = {
  type: true,
  direction: true,
  nativeDetail: true,
  erc20Detail: true,
} as const;

export interface ListTransactionsFilter {
  limit: number;
  offset: number;
  type?: string;
  sort: 'timestamp' | 'createdAt';
  order: 'asc' | 'desc';
}

function buildWhere(portfolioId: number, typeFilter?: string): Prisma.TransactionWhereInput {
  return {
    portfolioId,
    ...(typeFilter ? { type: { name: typeFilter } } : {}),
  };
}

export async function findTransactionById(id: number): Promise<TransactionWithAllRelations | null> {
  return prisma.transaction.findUnique({
    where: { id },
    include: DETAIL_INCLUDE,
  }) as Promise<TransactionWithAllRelations | null>;
}

export async function findTransactionWithAllInTx(
  tx: TxClient,
  id: number,
): Promise<TransactionWithAllRelations | null> {
  return tx.transaction.findUnique({
    where: { id },
    include: DETAIL_INCLUDE,
  }) as Promise<TransactionWithAllRelations | null>;
}

export async function listTransactions(
  portfolioId: number,
  filters: ListTransactionsFilter,
): Promise<TransactionWithListIncludes[]> {
  const where = buildWhere(portfolioId, filters.type);
  return prisma.transaction.findMany({
    where,
    orderBy: { [filters.sort]: filters.order },
    take: filters.limit,
    skip: filters.offset,
    include: LIST_INCLUDE,
  }) as Promise<TransactionWithListIncludes[]>;
}

export async function countTransactions(
  portfolioId: number,
  typeFilter?: string,
): Promise<number> {
  return prisma.transaction.count({ where: buildWhere(portfolioId, typeFilter) });
}

// retrofit-13: cross-portfolio reads for the dashboard Overview aggregate. Ownership
// is enforced via the Transaction → Portfolio relation filter (`portfolio: { userId }`),
// so these span EVERY portfolio the user owns in a single round-trip — no per-portfolio
// fan-out. Mirrors listTransactions/countTransactions but scopes by owner, not portfolio.
export async function listRecentTransactionsForUser(
  userId: number,
  limit: number,
): Promise<TransactionWithListIncludes[]> {
  return prisma.transaction.findMany({
    where: { portfolio: { userId } },
    orderBy: { timestamp: 'desc' },
    take: limit,
    include: LIST_INCLUDE,
  }) as Promise<TransactionWithListIncludes[]>;
}

export async function countTransactionsForUser(userId: number): Promise<number> {
  return prisma.transaction.count({ where: { portfolio: { userId } } });
}

interface CreateTransactionData {
  portfolioId: number;
  typeId: number;
  directionId: number;
  from?: string | null;
  to?: string | null;
  gasFee?: string | null;
  transactionHash?: string;
  timestamp: Date;
  notes?: string | null; // retrofit-7
  transferGroupId?: string | null; // retrofit-10: links the two legs of a transfer
}

export async function createTransactionRow(
  tx: TxClient,
  data: CreateTransactionData,
): Promise<{ id: number }> {
  return tx.transaction.create({ data, select: { id: true } });
}

export async function createNativeDetail(
  tx: TxClient,
  transactionId: number,
  data: { amount: string; symbol: string; usdValue: string; priceAtTime?: string | null },
): Promise<void> {
  await tx.nativeTransactionDetail.create({ data: { transactionId, ...data } });
}

export async function createErc20Detail(
  tx: TxClient,
  transactionId: number,
  data: {
    amount: string;
    symbol: string;
    tokenContractAddress: string;
    tokenName: string;
    tokenSymbol: string;
    usdValue: string;
    priceAtTime?: string | null;
  },
): Promise<void> {
  await tx.erc20TransactionDetail.create({ data: { transactionId, ...data } });
}

export async function createNftDetail(
  tx: TxClient,
  transactionId: number,
  data: {
    tokenContractAddress: string;
    nftTokenId: string;
    nftName?: string;
    collectionName?: string;
  },
): Promise<void> {
  await tx.nftTransactionDetail.create({ data: { transactionId, ...data } });
}

export async function updateTransactionBase(
  tx: TxClient,
  id: number,
  data: {
    directionId?: number;
    from?: string | null;
    to?: string | null;
    gasFee?: string | null;
    timestamp?: Date;
    notes?: string | null; // retrofit-7
  },
): Promise<void> {
  await tx.transaction.update({ where: { id }, data });
}

export async function updateNativeDetail(
  tx: TxClient,
  transactionId: number,
  data: { amount?: string; symbol?: string; usdValue?: string; priceAtTime?: string },
): Promise<void> {
  await tx.nativeTransactionDetail.update({ where: { transactionId }, data });
}

export async function updateErc20Detail(
  tx: TxClient,
  transactionId: number,
  data: {
    amount?: string;
    symbol?: string;
    tokenContractAddress?: string;
    tokenName?: string;
    tokenSymbol?: string;
    usdValue?: string;
    priceAtTime?: string;
  },
): Promise<void> {
  await tx.erc20TransactionDetail.update({ where: { transactionId }, data });
}

export async function updateNftDetail(
  tx: TxClient,
  transactionId: number,
  data: {
    tokenContractAddress?: string;
    nftName?: string | null;
    nftTokenId?: string;
    collectionName?: string | null;
  },
): Promise<void> {
  await tx.nftTransactionDetail.update({ where: { transactionId }, data });
}

export async function deleteTransactionRow(tx: TxClient, id: number): Promise<void> {
  await tx.transaction.delete({ where: { id } });
}

// retrofit-45: cross-portfolio buy/sell event stream for the overview reconstruction.
// Returns all buy/sell events (native + erc20, NFT excluded) across every portfolio the
// user owns, sorted ASC by timestamp then id (same tie-break as recalc). Transfer-group
// legs (transferGroupId != null) are included here — the balance reconstruction applies
// them; the markers builder skips them separately.
export interface TokenTxEvent {
  symbol: string;
  dir: 'buy' | 'sell';
  amount: number;
  usdValue: number;
  ts: Date;
  portfolioId: number;
  transferGroupId: string | null;
}

export async function findUserTokenTxEvents(userId: number): Promise<TokenTxEvent[]> {
  const rows = await prisma.transaction.findMany({
    where: {
      portfolio: { userId },
      direction: { name: { in: ['buy', 'sell'] } },
      OR: [{ nativeDetail: { isNot: null } }, { erc20Detail: { isNot: null } }],
    },
    select: {
      id: true,
      portfolioId: true,
      transferGroupId: true,
      timestamp: true,
      direction: { select: { name: true } },
      nativeDetail: { select: { symbol: true, amount: true, usdValue: true } },
      erc20Detail: { select: { symbol: true, amount: true, usdValue: true } },
    },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => {
    const detail = (row.nativeDetail ?? row.erc20Detail)!;
    return {
      symbol: detail.symbol,
      dir: row.direction.name as 'buy' | 'sell',
      amount: Number(detail.amount.toString()),
      usdValue: Number(detail.usdValue.toString()),
      ts: row.timestamp,
      portfolioId: row.portfolioId,
      transferGroupId: row.transferGroupId,
    };
  });
}
