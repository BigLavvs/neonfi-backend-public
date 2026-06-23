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
  portfolioIds?: number[],
): Promise<TransactionWithListIncludes[]> {
  // retrofit-50: an optional portfolio whitelist scopes the overview recent-tx list to the
  // selected portfolios. `portfolio: { userId }` still enforces ownership, so a foreign id
  // in the list matches nothing.
  return prisma.transaction.findMany({
    where: {
      portfolio: { userId },
      ...(portfolioIds ? { portfolioId: { in: portfolioIds } } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
    include: LIST_INCLUDE,
  }) as Promise<TransactionWithListIncludes[]>;
}

// retrofit-79 (§5): countTransactionsForUser removed — its only caller (the dead
// countUserTransactions service fn) is gone; the Overview counts per portfolio below.

// retrofit-49 (#8): DB transaction count grouped per portfolio for all the user's
// portfolios, in one round-trip. The Overview uses this as the per-portfolio fallback for
// portfolios that aren't connected or have no provider-reported externalTxCount.
export async function countTransactionsByPortfolioForUser(
  userId: number,
): Promise<Map<number, number>> {
  const grouped = await prisma.transaction.groupBy({
    by: ['portfolioId'],
    where: { portfolio: { userId } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.portfolioId, g._count._all]));
}

// retrofit-66: the earliest transaction timestamp for a portfolio (null when it has none).
// The Overview combines this with portfolio.createdAt to expose each portfolio's inception
// date, so the frontend can clamp the manual value-history reconstruction (a backdated logged
// transaction legitimately starts the line earlier than createdAt).
export async function findEarliestTransactionDate(portfolioId: number): Promise<Date | null> {
  const row = await prisma.transaction.findFirst({
    where: { portfolioId },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  });
  return row?.timestamp ?? null;
}

// perf #43: earliest transaction timestamp per portfolio for ALL the user's portfolios in ONE
// groupBy (the Overview previously fanned out one findFirst per portfolio). Mirrors
// countTransactionsByPortfolioForUser. Only portfolios with ≥1 transaction appear in the map.
export async function findEarliestTransactionDatesByPortfolioForUser(
  userId: number,
): Promise<Map<number, Date>> {
  const grouped = await prisma.transaction.groupBy({
    by: ['portfolioId'],
    where: { portfolio: { userId } },
    _min: { timestamp: true },
  });
  const map = new Map<number, Date>();
  for (const g of grouped) {
    if (g._min.timestamp) map.set(g.portfolioId, g._min.timestamp);
  }
  return map;
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
