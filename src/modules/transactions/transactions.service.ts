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

/**
 * Stage 14 (§1.7): total USD deposits (sum of `buy` usdValue across native + erc20)
 * and total USD withdrawals (sum of `sell`). NFT transactions don't carry a usdValue
 * and never contribute. Used by the analytics summary endpoint. Aggregates run as a
 * single round-trip of four parallel _sum queries.
 */
export async function getDepositWithdrawalTotals(
  portfolioId: number,
): Promise<{ totalDeposits: number; totalWithdrawals: number }> {
  const [nativeBuys, nativeSells, erc20Buys, erc20Sells] = await Promise.all([
    prisma.nativeTransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'buy' } } },
      _sum: { usdValue: true },
    }),
    prisma.nativeTransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'sell' } } },
      _sum: { usdValue: true },
    }),
    prisma.erc20TransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'buy' } } },
      _sum: { usdValue: true },
    }),
    prisma.erc20TransactionDetail.aggregate({
      where: { transaction: { portfolioId, direction: { name: 'sell' } } },
      _sum: { usdValue: true },
    }),
  ]);
  const toNum = (d: { _sum: { usdValue: Prisma.Decimal | null } }): number =>
    d._sum.usdValue ? Number(d._sum.usdValue.toString()) : 0;
  return {
    totalDeposits: toNum(nativeBuys) + toNum(erc20Buys),
    totalWithdrawals: toNum(nativeSells) + toNum(erc20Sells),
  };
}

export { invalidatePnlCache, TransactionError } from './transactions.shared.private.js';
export { createTransaction } from './transactions.create.private.js';
export { createTransactionFromWebhook, createNftTransactionFromWebhook, seedAcquisitionInTx, WALLET_SYNC_OPENING_NOTE, reconcileWalletOpeningLot } from './transactions.webhook.private.js';
export { createCrossPortfolioTransfer } from './transactions.transfer.private.js';
export { listPortfolioTransactions, listRecentUserTransactions, countUserTransactionsByPortfolio, earliestUserTransactionDate, earliestUserTransactionDatesByPortfolio, getPortfolioTransaction } from './transactions.reads.private.js';
export { updateTransaction, deleteTransaction } from './transactions.mutations.private.js';
