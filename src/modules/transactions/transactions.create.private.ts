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
export async function createTransaction(
  portfolio: PortfolioWithRelations,
  body: CreateTransactionBody,
): Promise<TransactionDetailDTO> {
  assertManualPortfolio(portfolio);

  // Resolve lookup rows OUTSIDE the transaction (static seeds, safe to read first)
  const [typeRow, directionRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: body.type } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: body.direction } }),
  ]);

  // Resolve token + asset. retrofit-27 §6: a `buy` of an unheld token AUTO-CREATES the
  // asset (a pure trade: openingBalance=0, cost-unknown — the buy itself sets cost via
  // recalc), subject to the same free-tier rank gate as POST /assets. sell/transfer of an
  // unheld token stays ASSET_NOT_IN_PORTFOLIO. A `sell` exceeding holdings is rejected
  // (INSUFFICIENT_BALANCE) — no negative balances via the create path (PATCH still allows it).
  let tokenId: number | null = null;
  let autoCreateAsset = false;
  if (body.type === 'native' || body.type === 'erc20') {
    const token = await prisma.token.findUnique({ where: { symbol: body.symbol } });
    if (!token) {
      throw new TransactionError(
        400,
        'UNKNOWN_TOKEN_SYMBOL',
        `Unknown token symbol: ${body.symbol}`,
      );
    }
    tokenId = token.id;
    const asset = await prisma.asset.findUnique({
      where: { portfolioId_tokenId: { portfolioId: portfolio.id, tokenId: token.id } },
    });
    if (body.direction === 'buy') {
      if (!asset) {
        const effectivePlan = await getEffectivePlan(portfolio.userId);
        if (effectivePlan === 'free' && (token.rank === null || token.rank > 10)) {
          throw new TransactionError(
            403,
            'PLAN_LIMIT_REACHED',
            'Your plan only allows tokens ranked in the top 10',
          );
        }
        autoCreateAsset = true;
      }
    } else {
      // sell or transfer of an unheld token
      if (!asset) {
        throw new TransactionError(
          400,
          'ASSET_NOT_IN_PORTFOLIO',
          'Add the token to your portfolio first before logging transactions for it',
        );
      }
      if (body.direction === 'sell' && Number(body.amount) > Number(asset.balance.toString())) {
        throw new TransactionError(
          400,
          'INSUFFICIENT_BALANCE',
          'Cannot sell more than the current balance',
        );
      }
    }
  }

  // USD value at write-time for balance-affecting types (retrofit-2 §1.3). retrofit-7:
  // a user-entered priceAtTime (native/erc20 only) overrides the current price so
  // manual cost basis is accurate; otherwise the current-price path is unchanged.
  let usdValue: string | null = null;
  if (body.type === 'native' || body.type === 'erc20') {
    usdValue = await computeUsdValue(body.symbol, body.amount, body.priceAtTime);
  }

  const newTxId = await prisma.$transaction(
    async (tx) => {
      // retrofit-27 §6: auto-create the Asset for a buy of an unheld token, inside the tx so
      // it rolls back with the rest if the insert fails (e.g. duplicate hash). Pure trade —
      // openingBalance/openingCostBasis default to 0/null; recalc sets cost from this buy.
      if (autoCreateAsset && tokenId !== null) {
        await tx.asset.create({
          data: { portfolioId: portfolio.id, tokenId, balance: '0', netDeposit: '0' },
        });
      }

      let created: { id: number };
      try {
        created = await createTransactionRow(tx, {
          portfolioId: portfolio.id,
          typeId: typeRow.id,
          directionId: directionRow.id,
          from: body.from ?? null,
          to: body.to ?? null,
          gasFee: body.gasFee ?? null,
          transactionHash: body.transactionHash,
          timestamp: new Date(body.timestamp),
          notes: body.notes ?? null,
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new TransactionError(
            409,
            'TRANSACTION_HASH_DUPLICATE',
            'A transaction with this hash already exists',
          );
        }
        throw e;
      }

      if (body.type === 'native') {
        await createNativeDetail(tx, created.id, {
          amount: body.amount,
          symbol: body.symbol,
          usdValue: usdValue!,
          priceAtTime: body.priceAtTime ?? null,
        });
      } else if (body.type === 'erc20') {
        await createErc20Detail(tx, created.id, {
          amount: body.amount,
          symbol: body.symbol,
          tokenContractAddress: body.tokenContractAddress,
          tokenName: body.tokenName,
          tokenSymbol: body.tokenSymbol,
          usdValue: usdValue!,
          priceAtTime: body.priceAtTime ?? null,
        });
      } else {
        await createNftDetail(tx, created.id, {
          tokenContractAddress: body.tokenContractAddress,
          nftTokenId: body.nftTokenId,
          nftName: body.nftName,
          collectionName: body.collectionName,
        });
      }

      if (tokenId !== null) {
        await recalcAssetBalance(tx, portfolio.id, tokenId);
        await recalcPortfolioNetDeposit(tx, portfolio.id);
      }

      return created.id;
    },
    { timeout: 15000 },
  );

  await invalidatePnlCache(portfolio.id);

  const full = await findTransactionById(newTxId);
  if (!full) throw new Error('Transaction not found after creation');
  return toTransactionDetailDTO(full);
}

// ---------------------------------------------------------------------------
// POST (webhook bypass — Stage 11)
// ---------------------------------------------------------------------------

// Webhook-driven counterpart to createTransaction. Bypasses two user-facing guards:
//   1. CONNECTED_PORTFOLIO_READ_ONLY — webhooks ARE the source of truth for connected portfolios.
//   2. ASSET_NOT_IN_PORTFOLIO       — auto-creates the Asset row when missing; Moralis tells us
//      what tokens the wallet holds, so we can't require the user to pre-add them.
// Plan-rank check (Stage 8) is also skipped: the rank cap governs what a free user can ADD,
// not what tokens a connected wallet actually holds. All on-chain holdings are shown.
// Direction convention (differs from Stage 9A manual-portfolio transfer=no-op):
//   IN  (to === walletAddress) → direction='buy'  → balance += amount
//   OUT (from === walletAddress) → direction='sell' → balance -= amount


