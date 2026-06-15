import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { portfolioDerivedCacheKeys } from '../../lib/portfolio-cache-keys.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
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
  type ListTransactionsFilter,
} from './transactions.repository.js';
import {
  toTransactionListDTO,
  toTransactionDetailDTO,
  type TransactionListDTO,
  type TransactionDetailDTO,
} from './transactions.dto.js';
import type { CreateTransactionBody, UpdateTransactionBody } from './transactions.schemas.js';
import { recalcAssetBalance, recalcPortfolioNetDeposit } from './recalc.js';
import { computeUsdValue } from './usd-value.js';

// PnL/analytics cache invalidation (retrofit-2 §1.6; extended Stage 14 §1.9). Build
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

export class TransactionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

function assertManualPortfolio(portfolio: PortfolioWithRelations): void {
  if (portfolio.type.name === 'connected') {
    throw new TransactionError(
      403,
      'CONNECTED_PORTFOLIO_READ_ONLY',
      'Transactions in connected portfolios are read-only',
    );
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

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

  // Resolve token for native/erc20; check asset exists in portfolio
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
    const asset = await prisma.asset.findUnique({
      where: { portfolioId_tokenId: { portfolioId: portfolio.id, tokenId: token.id } },
    });
    if (!asset) {
      throw new TransactionError(
        400,
        'ASSET_NOT_IN_PORTFOLIO',
        'Add the token to your portfolio first before logging transactions for it',
      );
    }
    tokenId = token.id;
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
export async function createTransactionFromWebhook(params: {
  portfolio: PortfolioWithRelations;
  body: CreateTransactionBody;
}): Promise<TransactionDetailDTO> {
  const { portfolio, body } = params;

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
  let usdValue: string | null = null;
  if (body.type === 'native' || body.type === 'erc20') {
    usdValue = await computeUsdValue(body.symbol, body.amount);
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
  tx: Prisma.TransactionClient,
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
// GET list
// ---------------------------------------------------------------------------

export async function listPortfolioTransactions(
  portfolio: PortfolioWithRelations,
  filters: ListTransactionsFilter,
): Promise<{ transactions: TransactionListDTO[]; meta: { limit: number; offset: number; total: number } }> {
  const [transactions, total] = await Promise.all([
    listTransactions(portfolio.id, filters),
    countTransactions(portfolio.id, filters.type),
  ]);
  return {
    transactions: transactions.map(toTransactionListDTO),
    meta: { limit: filters.limit, offset: filters.offset, total },
  };
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
