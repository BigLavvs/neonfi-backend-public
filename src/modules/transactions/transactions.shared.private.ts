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

// PnL/analytics cache invalidation (retrofit-2). Build
// Guide §4.3/§6.3 mandate the portfolio's derived Redis caches be invalidated after
// every mutation commit. Stage 14 widened the set from the single portfolio_pnl key
// to the full portfolioDerivedCacheKeys list (PnL + 3 analytics keys) so a single
// source stays in sync across every CUD callsite. del on a missing key is a harmless
// no-op. Run AFTER the $transaction commits and never let a cache failure roll the
// write back — stale derived data for 5 min is recoverable.
export async function invalidatePnlCache(portfolioId: number): Promise<void> {
  const keys = portfolioDerivedCacheKeys(portfolioId);
  await redis
    .del(...keys)
    .catch((e: Error) =>
      console.error(
        `[transactions] cache invalidation failed for portfolio ${portfolioId}:`,
        e.message,
      ),
    );
}

export class TransactionError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

export function assertManualPortfolio(portfolio: PortfolioWithRelations): void {
  if (portfolio.type.name === 'connected') {
    throw new TransactionError(403, 'CONNECTED_PORTFOLIO_READ_ONLY', 'Transactions in connected portfolios are read-only');
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

