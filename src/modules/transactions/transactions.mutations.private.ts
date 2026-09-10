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
export async function updateTransaction(
  portfolio: PortfolioWithRelations,
  txId: number,
  body: UpdateTransactionBody,
): Promise<TransactionDetailDTO> {
  assertManualPortfolio(portfolio);

  const existing = await findTransactionById(txId);
  if (!existing || existing.portfolioId !== portfolio.id) {
    throw new TransactionError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
  }

  // Resolve new direction if provided
  let newDirectionId: number | undefined;
  if (body.direction !== undefined) {
    const dirRow = await prisma.transactionDirection.findUniqueOrThrow({
      where: { name: body.direction },
    });
    newDirectionId = dirRow.id;
  }

  const typeName = existing.type.name;
  const oldSymbol =
    existing.nativeDetail?.symbol ?? existing.erc20Detail?.symbol ?? null;
  const oldAmount =
    existing.nativeDetail?.amount.toString() ??
    existing.erc20Detail?.amount.toString() ??
    null;

  // For native/erc20, resolve old and new tokenIds for recalc
  let oldTokenId: number | null = null;
  let newTokenId: number | null = null;

  if (typeName === 'native' || typeName === 'erc20') {
    if (oldSymbol) {
      const oldToken = await prisma.token.findUnique({ where: { symbol: oldSymbol } });
      if (oldToken) oldTokenId = oldToken.id;
    }

    if (body.symbol !== undefined && body.symbol !== oldSymbol) {
      const newToken = await prisma.token.findUnique({ where: { symbol: body.symbol } });
      if (!newToken) {
        throw new TransactionError(
          400,
          'UNKNOWN_TOKEN_SYMBOL',
          `Unknown token symbol: ${body.symbol}`,
        );
      }
      // Check new token's asset exists in portfolio
      const newAsset = await prisma.asset.findUnique({
        where: { portfolioId_tokenId: { portfolioId: portfolio.id, tokenId: newToken.id } },
      });
      if (!newAsset) {
        throw new TransactionError(
          400,
          'ASSET_NOT_IN_PORTFOLIO',
          'Add the token to your portfolio first before logging transactions for it',
        );
      }
      newTokenId = newToken.id;
    } else {
      newTokenId = oldTokenId;
    }
  }

  const balanceAffected =
    body.direction !== undefined || body.amount !== undefined || body.symbol !== undefined;
  // usdValue must be recomputed whenever amount, symbol, or the entered price changes
  // (retrofit-2 §1.8; retrofit-7 adds priceAtTime). Direction alone does NOT change
  // usdValue — recalc handles the sign flip.
  const usdAffected =
    body.amount !== undefined || body.symbol !== undefined || body.priceAtTime !== undefined;

  await prisma.$transaction(
    async (tx) => {
      const baseData: Record<string, unknown> = {};
      if (newDirectionId !== undefined) baseData.directionId = newDirectionId;
      if (body.from !== undefined) baseData.from = body.from;
      if (body.to !== undefined) baseData.to = body.to;
      if (body.gasFee !== undefined) baseData.gasFee = body.gasFee;
      if (body.timestamp !== undefined) baseData.timestamp = new Date(body.timestamp);
      if (body.notes !== undefined) baseData.notes = body.notes;

      if (Object.keys(baseData).length > 0) {
        await updateTransactionBase(
          tx,
          txId,
          baseData as Parameters<typeof updateTransactionBase>[2],
        );
      }

      if (typeName === 'native') {
        const nativeData: { amount?: string; symbol?: string; usdValue?: string; priceAtTime?: string } = {};
        if (body.amount !== undefined) nativeData.amount = body.amount;
        if (body.symbol !== undefined) nativeData.symbol = body.symbol;
        if (body.priceAtTime !== undefined) nativeData.priceAtTime = body.priceAtTime;
        if (usdAffected) {
          const newSymbol = body.symbol ?? oldSymbol ?? '';
          const newAmount = body.amount ?? oldAmount ?? '0';
          if (newSymbol) {
            // retrofit-7: new entered price if given, else the stored priceAtTime, else
            // (undefined) current price.
            nativeData.usdValue = await computeUsdValue(
              newSymbol,
              newAmount,
              body.priceAtTime ?? existing.nativeDetail?.priceAtTime?.toString(),
            );
          }
        }
        if (Object.keys(nativeData).length > 0) {
          await updateNativeDetail(tx, txId, nativeData);
        }
      } else if (typeName === 'erc20') {
        const erc20Data: {
          amount?: string;
          symbol?: string;
          tokenContractAddress?: string;
          tokenName?: string;
          tokenSymbol?: string;
          usdValue?: string;
          priceAtTime?: string;
        } = {};
        if (body.amount !== undefined) erc20Data.amount = body.amount;
        if (body.symbol !== undefined) erc20Data.symbol = body.symbol;
        if (body.tokenContractAddress !== undefined)
          erc20Data.tokenContractAddress = body.tokenContractAddress;
        if (body.tokenName !== undefined) erc20Data.tokenName = body.tokenName;
        if (body.tokenSymbol !== undefined) erc20Data.tokenSymbol = body.tokenSymbol;
        if (body.priceAtTime !== undefined) erc20Data.priceAtTime = body.priceAtTime;
        if (usdAffected) {
          const newSymbol = body.symbol ?? oldSymbol ?? '';
          const newAmount = body.amount ?? oldAmount ?? '0';
          if (newSymbol) {
            // retrofit-7: new entered price if given, else the stored priceAtTime, else
            // (undefined) current price.
            erc20Data.usdValue = await computeUsdValue(
              newSymbol,
              newAmount,
              body.priceAtTime ?? existing.erc20Detail?.priceAtTime?.toString(),
            );
          }
        }
        if (Object.keys(erc20Data).length > 0) {
          await updateErc20Detail(tx, txId, erc20Data);
        }
      } else if (typeName === 'nft') {
        const nftData: {
          tokenContractAddress?: string;
          nftName?: string | null;
          nftTokenId?: string;
          collectionName?: string | null;
        } = {};
        if (body.tokenContractAddress !== undefined)
          nftData.tokenContractAddress = body.tokenContractAddress;
        if (body.nftName !== undefined) nftData.nftName = body.nftName;
        if (body.nftTokenId !== undefined) nftData.nftTokenId = body.nftTokenId;
        if (body.collectionName !== undefined) nftData.collectionName = body.collectionName;
        if (Object.keys(nftData).length > 0) {
          await updateNftDetail(tx, txId, nftData);
        }
      }

      // retrofit-7: recalc when balance OR usdValue changed. Pre-retrofit-7 usdAffected
      // (amount/symbol) was always a subset of balanceAffected, so netDeposit followed
      // for free. priceAtTime now changes usdValue WITHOUT changing balance, so a
      // priceAtTime-only edit must still trigger the netDeposit recalc — otherwise
      // Asset/Portfolio.netDeposit (= Σ usdValue) goes stale and PnL is wrong.
      if ((balanceAffected || usdAffected) && (typeName === 'native' || typeName === 'erc20')) {
        if (oldTokenId !== null && newTokenId !== null && oldTokenId !== newTokenId) {
          // Symbol changed — recalc both old and new token's balances
          await recalcAssetBalance(tx, portfolio.id, oldTokenId);
          await recalcAssetBalance(tx, portfolio.id, newTokenId);
        } else if (oldTokenId !== null) {
          await recalcAssetBalance(tx, portfolio.id, oldTokenId);
        } else if (newTokenId !== null) {
          await recalcAssetBalance(tx, portfolio.id, newTokenId);
        }
        await recalcPortfolioNetDeposit(tx, portfolio.id);
      }
    },
    { timeout: 15000 },
  );

  await invalidatePnlCache(portfolio.id);

  const updated = await findTransactionById(txId);
  if (!updated) throw new Error('Transaction not found after update');
  return toTransactionDetailDTO(updated);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function deleteTransaction(
  portfolio: PortfolioWithRelations,
  txId: number,
): Promise<void> {
  assertManualPortfolio(portfolio);

  const existing = await findTransactionById(txId);
  if (!existing || existing.portfolioId !== portfolio.id) {
    throw new TransactionError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
  }

  // retrofit-10 (C4b): a transfer is a PAIR of legs sharing a transferGroupId. Deleting
  // either leg must remove BOTH and recalc BOTH portfolios — otherwise one side keeps a
  // dangling sell/buy and balances/netDeposit desync. Both legs belong to the same user
  // (transfers only happen between the user's own manual portfolios), so the source-
  // portfolio ownership middleware that gated this request already authorizes deleting
  // the dest leg too.
  if (existing.transferGroupId !== null) {
    const legs = await prisma.transaction.findMany({
      where: { transferGroupId: existing.transferGroupId },
      include: { nativeDetail: true, erc20Detail: true },
    });

    // Resolve the (portfolioId, tokenId) pairs to recalc and the distinct portfolios.
    // Legs are native, but read the symbol from either detail defensively.
    const recalcTargets: Array<{ portfolioId: number; tokenId: number }> = [];
    const portfolioIds = new Set<number>();
    for (const leg of legs) {
      portfolioIds.add(leg.portfolioId);
      const legSymbol = leg.nativeDetail?.symbol ?? leg.erc20Detail?.symbol ?? null;
      if (legSymbol) {
        const legToken = await prisma.token.findUnique({ where: { symbol: legSymbol } });
        if (legToken) recalcTargets.push({ portfolioId: leg.portfolioId, tokenId: legToken.id });
      }
    }

    await prisma.$transaction(
      async (tx) => {
        for (const leg of legs) {
          await deleteTransactionRow(tx, leg.id);
        }
        // Recalc per affected asset first, then per portfolio (netDeposit sums assets).
        for (const target of recalcTargets) {
          await recalcAssetBalance(tx, target.portfolioId, target.tokenId);
        }
        for (const pid of portfolioIds) {
          await recalcPortfolioNetDeposit(tx, pid);
        }
      },
      { timeout: 15000 },
    );

    for (const pid of portfolioIds) {
      await invalidatePnlCache(pid);
    }
    return;
  }

  const typeName = existing.type.name;
  const symbol =
    existing.nativeDetail?.symbol ?? existing.erc20Detail?.symbol ?? null;
  let tokenId: number | null = null;
  if ((typeName === 'native' || typeName === 'erc20') && symbol) {
    const token = await prisma.token.findUnique({ where: { symbol } });
    if (token) tokenId = token.id;
  }

  await prisma.$transaction(
    async (tx) => {
      await deleteTransactionRow(tx, txId);
      if (tokenId !== null) {
        await recalcAssetBalance(tx, portfolio.id, tokenId);
        await recalcPortfolioNetDeposit(tx, portfolio.id);
      }
    },
    { timeout: 15000 },
  );

  await invalidatePnlCache(portfolio.id);
}



