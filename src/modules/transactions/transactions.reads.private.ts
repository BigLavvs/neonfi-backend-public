import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { portfolioDerivedCacheKeys } from '../../lib/portfolio-cache-keys.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import { findAssetByPortfolioToken } from '../assets/assets.repository.js';
import {
  createTransactionRow,
  createNativeDetail,
  createErc20Detail,
  createNftDetail,
  findTransactionById,
  updateTransactionBase,
  updateNativeDetail,
  updateErc20Detail,
  updateNftDetail,
  deleteTransactionRow,
  listTransactions,
  countTransactions,
  listRecentTransactionsForUser,
  countTransactionsByPortfolioForUser,
  findEarliestTransactionDate,
  findEarliestTransactionDatesByPortfolioForUser,
  type ListTransactionsFilter,
} from './transactions.repository.js';
import {
  toTransactionListDTO,
  toTransactionDetailDTO,
  type TransactionListDTO,
  type TransactionDetailDTO,
} from './transactions.dto.js';
import type {
  CreateTransactionBody,
  UpdateTransactionBody,
  TransferBody,
} from './transactions.schemas.js';
import { recalcAssetBalance, recalcPortfolioNetDeposit } from './recalc.js';
import { computeUsdValue } from './usd-value.js';
import { toDecimalString } from '../../lib/decimal.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';

import { invalidatePnlCache, TransactionError, assertManualPortfolio } from './transactions.shared.private.js';
async function buildLogoMap(
  rows: Array<{ nativeDetail?: { symbol: string } | null; erc20Detail?: { symbol: string } | null }>,
): Promise<Map<string, string | null>> {
  const symbols = new Set<string>();
  for (const r of rows) {
    const s = r.nativeDetail?.symbol ?? r.erc20Detail?.symbol;
    if (s) symbols.add(s);
  }
  if (symbols.size === 0) return new Map();
  const tokens = await prisma.token.findMany({
    where: { symbol: { in: [...symbols] } },
    select: { symbol: true, logoUrl: true },
  });
  return new Map(tokens.map((t) => [t.symbol, t.logoUrl]));
}

function logoFor(
  row: { nativeDetail?: { symbol: string } | null; erc20Detail?: { symbol: string } | null },
  logoMap: Map<string, string | null>,
): string | null {
  const s = row.nativeDetail?.symbol ?? row.erc20Detail?.symbol;
  return s ? (logoMap.get(s) ?? null) : null;
}

export async function listPortfolioTransactions(
  portfolio: PortfolioWithRelations,
  filters: ListTransactionsFilter,
): Promise<{ transactions: TransactionListDTO[]; meta: { limit: number; offset: number; total: number } }> {
  const [transactions, total] = await Promise.all([
    listTransactions(portfolio.id, filters),
    countTransactions(portfolio.id, filters.type),
  ]);
  const logoMap = await buildLogoMap(transactions);
  return {
    transactions: transactions.map((t) => toTransactionListDTO(t, logoFor(t, logoMap))),
    meta: { limit: filters.limit, offset: filters.offset, total },
  };
}

// ---------------------------------------------------------------------------
// Cross-portfolio reads (retrofit-13) — for the Overview module
// ---------------------------------------------------------------------------

// Thin wrappers over the owner-scoped repository queries. The Overview module reads
// transaction data only through this service surface (module isolation, mirroring how
// analytics.service composes other modules). Rows are mapped with the existing
// toTransactionListDTO so the Overview's recentTransactions shape matches the per-
// portfolio list exactly.
export async function listRecentUserTransactions(
  userId: number,
  limit: number,
  portfolioIds?: number[], // retrofit-50: scope to the overview portfolio filter when set
): Promise<TransactionListDTO[]> {
  const rows = await listRecentTransactionsForUser(userId, limit, portfolioIds);
  const logoMap = await buildLogoMap(rows);
  return rows.map((t) => toTransactionListDTO(t, logoFor(t, logoMap)));
}

// retrofit-79 (§5): countUserTransactions (a user-wide DB row count) was dead — defined here,
// never called (the Overview uses countUserTransactionsByPortfolio + externalTxCount). Removed
// along with its repository helper countTransactionsForUser.

// retrofit-49 (#8): per-portfolio DB tx counts for the Overview's transactionCount, which
// blends these with each connected portfolio's provider-reported externalTxCount.
export function countUserTransactionsByPortfolio(userId: number): Promise<Map<number, number>> {
  return countTransactionsByPortfolioForUser(userId);
}

// retrofit-66: the earliest transaction timestamp for a portfolio (null when none). The
// Overview pairs it with portfolio.createdAt to derive each portfolio's inceptionDate. Thin
// wrapper over the repository, keeping the Overview module reading transactions only through
// this service surface (module isolation).
export function earliestUserTransactionDate(portfolioId: number): Promise<Date | null> {
  return findEarliestTransactionDate(portfolioId);
}

// perf #43: batched variant — earliest tx date for ALL the user's portfolios in one groupBy.
// The Overview uses this instead of one earliestUserTransactionDate call per portfolio.
export function earliestUserTransactionDatesByPortfolio(userId: number): Promise<Map<number, Date>> {
  return findEarliestTransactionDatesByPortfolioForUser(userId);
}

// ---------------------------------------------------------------------------
// GET detail
// ---------------------------------------------------------------------------

export async function getPortfolioTransaction(
  portfolio: PortfolioWithRelations,
  txId: number,
): Promise<TransactionDetailDTO> {
  const tx = await findTransactionById(txId);
  if (!tx || tx.portfolioId !== portfolio.id) {
    throw new TransactionError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
  }
  return toTransactionDetailDTO(tx);
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------



