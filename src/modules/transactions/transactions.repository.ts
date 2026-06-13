import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { TransactionWithAllRelations, TransactionWithListIncludes } from './transactions.dto.js';

type TxClient = Prisma.TransactionClient;

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

interface CreateTransactionData {
  portfolioId: number;
  typeId: number;
  directionId: number;
  from?: string | null;
  to?: string | null;
  gasFee?: string | null;
  transactionHash?: string;
  timestamp: Date;
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
  data: { amount: string; symbol: string; usdValue: string },
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
  },
): Promise<void> {
  await tx.transaction.update({ where: { id }, data });
}

export async function updateNativeDetail(
  tx: TxClient,
  transactionId: number,
  data: { amount?: string; symbol?: string; usdValue?: string },
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
