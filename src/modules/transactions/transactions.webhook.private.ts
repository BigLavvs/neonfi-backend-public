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
export async function createTransactionFromWebhook(params: {
  portfolio: PortfolioWithRelations;
  body: CreateTransactionBody;
  // retrofit-49: a historical USD value supplied by the provider's transfer history. When
  // present (≥ 0) it drives usdValue directly (the REAL value at tx time) instead of the
  // current-price computeUsdValue lookup. Trimmed to Decimal(20,8). The live webhook path
  // omits it and keeps the current-price behaviour unchanged.
  usdValueOverride?: number | null;
}): Promise<TransactionDetailDTO> {
  const { portfolio, body, usdValueOverride } = params;

  const [typeRow, directionRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: body.type } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: body.direction } }),
  ]);

  let tokenId: number | null = null;
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
  }

  // USD value at write-time for balance-affecting types (retrofit-2 §1.3).
  // Webhooks only ever produce native/erc20 transfers (NFTs are handled separately).
  // retrofit-49: a provided historical usdValueOverride wins over the current-price lookup.
  let usdValue: string | null = null;
  if (body.type === 'native' || body.type === 'erc20') {
    usdValue =
      usdValueOverride != null
        ? toDecimalString(usdValueOverride)
        : await computeUsdValue(body.symbol, body.amount);
  }

  const newTxId = await prisma.$transaction(
    async (tx) => {
      // Auto-create Asset if not yet in portfolio — bypasses ASSET_NOT_IN_PORTFOLIO check
      if (tokenId !== null) {
        const asset = await tx.asset.findUnique({
          where: { portfolioId_tokenId: { portfolioId: portfolio.id, tokenId } },
        });
        if (!asset) {
          await tx.asset.create({
            data: { portfolioId: portfolio.id, tokenId, balance: '0', netDeposit: '0' },
          });
        }
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
        });
      } else if (body.type === 'erc20') {
        await createErc20Detail(tx, created.id, {
          amount: body.amount,
          symbol: body.symbol,
          tokenContractAddress: body.tokenContractAddress,
          tokenName: body.tokenName,
          tokenSymbol: body.tokenSymbol,
          usdValue: usdValue!,
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
// NFT transaction from import (retrofit-49)
// ---------------------------------------------------------------------------

// Writes an `nft`-type transaction for an imported NFT transfer (connected-wallet history
// import, wallet-data/sync.ts). The Nft *holdings* row is managed separately by the caller
// (the holdings table is portfolio-owned, like the webhook NFT path) — this only records the
// transfer as a transaction so it appears in the activity feed. NFTs carry no amount/usdValue
// and never touch Asset balances, so there is NO recalc and NO PnL-cache invalidation.
// Dedupe: a duplicate transactionHash (the leg was already imported, OR another leg of the
// same multi-asset tx already claimed the hash) surfaces as TRANSACTION_HASH_DUPLICATE for
// the caller to skip — mirrors createTransactionFromWebhook.
export async function createNftTransactionFromWebhook(params: {
  portfolio: PortfolioWithRelations;
  body: {
    direction: 'buy' | 'sell';
    tokenContractAddress: string;
    nftTokenId: string;
    nftName?: string;
    collectionName?: string;
    timestamp: string;
    transactionHash?: string;
    from?: string | null;
    to?: string | null;
    gasFee?: string | null;
  };
}): Promise<void> {
  const { portfolio, body } = params;
  const [typeRow, directionRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'nft' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: body.direction } }),
  ]);

  await prisma.$transaction(
    async (tx) => {
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
      await createNftDetail(tx, created.id, {
        tokenContractAddress: body.tokenContractAddress,
        nftTokenId: body.nftTokenId,
        nftName: body.nftName,
        collectionName: body.collectionName,
      });
    },
    { timeout: 15000 },
  );
}

// ---------------------------------------------------------------------------
// Shared acquisition seed (retrofit-8 §1)
// ---------------------------------------------------------------------------

// Seeds a manual `native buy` acquisition. The Asset MUST already be created by the
// caller in the SAME tx (assets.service.addAsset / portfolios.service.createPortfolio);
// this only writes the transaction + native detail and recalcs. Transactions module
// owns the Transaction table, so the seed lives here and assets/portfolios call it
// (module isolation). Mirrors createTransactionFromWebhook: the static native/buy seed
// rows are resolved via the global prisma client (low in-tx query count) while the tx +
// detail + recalc are written via the passed tx client, so the asset(s) and the seed
// commit atomically. Manual entries are always `native` — the Token catalog has no
// contract address to build an erc20 detail; erc20/nft stay webhook-only.
// computeUsdValue is priceAtTime-aware (retrofit-7): a user-entered priceAtTime drives
// the cost basis, otherwise the current price at write-time is used.
export async function seedAcquisitionInTx(
  tx: PrismaTransactionClient,
  params: {
    portfolioId: number;
    tokenId: number;
    symbol: string;
    amount: string;
    priceAtTime?: string;
    timestamp?: string;
    notes?: string | null;
  },
): Promise<void> {
  const [typeRow, dirRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } }),
  ]);
  const usdValue = await computeUsdValue(params.symbol, params.amount, params.priceAtTime);
  const created = await createTransactionRow(tx, {
    portfolioId: params.portfolioId,
    typeId: typeRow.id,
    directionId: dirRow.id,
    timestamp: params.timestamp ? new Date(params.timestamp) : new Date(),
    notes: params.notes ?? null,
  });
  await createNativeDetail(tx, created.id, {
    amount: params.amount,
    symbol: params.symbol,
    usdValue,
    priceAtTime: params.priceAtTime ?? null,
  });
  await recalcAssetBalance(tx, params.portfolioId, params.tokenId);
  await recalcPortfolioNetDeposit(tx, params.portfolioId);
}

// ---------------------------------------------------------------------------
// Connected-wallet reconciling opening lot (retrofit-49 tag / retrofit-50 idempotent update)
// ---------------------------------------------------------------------------

// The wallet-sync reconciling opening lot (the residual "starting balance" seeded so the
// stored balance equals on-chain) is TAGGED with this note so a later resync can find and
// UPDATE it in place instead of inserting a duplicate. Manual transactions never use it.
export const WALLET_SYNC_OPENING_NOTE = 'wallet-sync:opening';

// retrofit-50: idempotently reconcile a held token's balance to the on-chain truth by
// UPDATING its tagged opening lot (never inserting a second one). residual = providerBalance
// − (current asset balance − the opening lot's current amount); i.e. the starting balance the
// recorded non-opening transactions don't account for. Re-runnable: a second call recomputes
// the same residual and writes the same amount, so balances/rows don't drift. When no tagged
// lot exists yet (a token first seen on this resync) one is created — only when the residual
// is meaningful. The Transaction/Asset writes stay in the transactions module (isolation); the
// caller (wallet-data/sync) supplies the provider balance + price and flushes caches once.
export async function reconcileWalletOpeningLot(params: {
  portfolio: PortfolioWithRelations;
  tokenId: number;
  symbol: string;
  providerBalance: number;
  usdPrice: number | null;
  openingAt: string; // ISO — used only when creating a lot that didn't exist before
}): Promise<void> {
  const { portfolio, tokenId, symbol, providerBalance, usdPrice, openingAt } = params;
  const portfolioId = portfolio.id;

  const [asset, opening] = await Promise.all([
    prisma.asset.findUnique({ where: { portfolioId_tokenId: { portfolioId, tokenId } } }),
    prisma.transaction.findFirst({
      where: { portfolioId, notes: WALLET_SYNC_OPENING_NOTE, nativeDetail: { symbol } },
      include: { nativeDetail: true },
    }),
  ]);

  const currentBalance = asset ? Number(asset.balance.toString()) : 0;
  const openingAmt = opening?.nativeDetail ? Number(opening.nativeDetail.amount.toString()) : 0;
  // The opening lot can only reconcile UP — a missed sell beyond the window can't push it
  // below 0 (same limitation as the initial sync). max(0, …) guards that.
  const residual = Math.max(0, providerBalance - (currentBalance - openingAmt));
  const amountStr = toDecimalString(residual);

  if (opening?.nativeDetail) {
    // Re-price the lot to the current price when the provider supplies one; else keep its
    // stored priceAtTime so cost basis stays stable. usdValue follows the new amount.
    const priceAtTime =
      usdPrice != null
        ? usdPrice.toFixed(8)
        : opening.nativeDetail.priceAtTime != null
          ? opening.nativeDetail.priceAtTime.toString()
          : undefined;
    const usdValue = await computeUsdValue(symbol, amountStr, priceAtTime);
    await prisma.$transaction(
      async (tx) => {
        await updateNativeDetail(tx, opening.id, {
          amount: amountStr,
          usdValue,
          ...(priceAtTime !== undefined ? { priceAtTime } : {}),
        });
        await recalcAssetBalance(tx, portfolioId, tokenId);
        await recalcPortfolioNetDeposit(tx, portfolioId);
      },
      { timeout: 15000 },
    );
    return;
  }

  // No tagged lot yet — create one (tagged), only if the residual is worth a lot.
  if (residual <= 0) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.asset.upsert({
        where: { portfolioId_tokenId: { portfolioId, tokenId } },
        update: {},
        create: { portfolioId, tokenId },
      });
      await seedAcquisitionInTx(tx, {
        portfolioId,
        tokenId,
        symbol,
        amount: amountStr,
        timestamp: openingAt,
        notes: WALLET_SYNC_OPENING_NOTE,
        ...(usdPrice != null ? { priceAtTime: usdPrice.toFixed(8) } : {}),
      });
    },
    { timeout: 15000 },
  );
}

// ---------------------------------------------------------------------------
// Cross-portfolio transfer (retrofit-10 / C4b)
// ---------------------------------------------------------------------------

// Moves `amount` of a token between two of the user's MANUAL portfolios as a paired
// transaction: a `sell` leg in the source and a `buy` leg in the dest, sharing a
// `transferGroupId`. The dest INHERITS the source's per-unit cost basis — both legs
// use the same usdValue = amount × (sourceAsset.netDeposit / sourceAsset.balance) —
// so the source loses exactly that basis and the dest gains it. Total cost basis is
// conserved across the two portfolios and the move creates NO fake PnL (Idowu's
// choice). recalc.ts is reused unchanged: a `sell` drops balance+netDeposit, a `buy`
// raises them. The existing `transfer` direction stays a no-op (address-transfer
// sub-mode is out of scope). Manual legs are `native` only (mirrors seedAcquisitionInTx
// — the Token catalog has no contract address for an erc20 detail).


