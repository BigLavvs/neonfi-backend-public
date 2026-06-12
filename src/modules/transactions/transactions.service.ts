import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
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
import { recalcAssetBalance } from './recalc.js';

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
        });
      } else if (body.type === 'erc20') {
        await createErc20Detail(tx, created.id, {
          amount: body.amount,
          symbol: body.symbol,
          tokenContractAddress: body.tokenContractAddress,
          tokenName: body.tokenName,
          tokenSymbol: body.tokenSymbol,
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
      }

      return created.id;
    },
    { timeout: 15000 },
  );

  const full = await findTransactionById(newTxId);
  if (!full) throw new Error('Transaction not found after creation');
  return toTransactionDetailDTO(full);
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

  await prisma.$transaction(
    async (tx) => {
      const baseData: Record<string, unknown> = {};
      if (newDirectionId !== undefined) baseData.directionId = newDirectionId;
      if (body.from !== undefined) baseData.from = body.from;
      if (body.to !== undefined) baseData.to = body.to;
      if (body.gasFee !== undefined) baseData.gasFee = body.gasFee;
      if (body.timestamp !== undefined) baseData.timestamp = new Date(body.timestamp);

      if (Object.keys(baseData).length > 0) {
        await updateTransactionBase(
          tx,
          txId,
          baseData as Parameters<typeof updateTransactionBase>[2],
        );
      }

      if (typeName === 'native') {
        const nativeData: { amount?: string; symbol?: string } = {};
        if (body.amount !== undefined) nativeData.amount = body.amount;
        if (body.symbol !== undefined) nativeData.symbol = body.symbol;
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
        } = {};
        if (body.amount !== undefined) erc20Data.amount = body.amount;
        if (body.symbol !== undefined) erc20Data.symbol = body.symbol;
        if (body.tokenContractAddress !== undefined)
          erc20Data.tokenContractAddress = body.tokenContractAddress;
        if (body.tokenName !== undefined) erc20Data.tokenName = body.tokenName;
        if (body.tokenSymbol !== undefined) erc20Data.tokenSymbol = body.tokenSymbol;
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

      if (balanceAffected && (typeName === 'native' || typeName === 'erc20')) {
        if (oldTokenId !== null && newTokenId !== null && oldTokenId !== newTokenId) {
          // Symbol changed — recalc both old and new token's balances
          await recalcAssetBalance(tx, portfolio.id, oldTokenId);
          await recalcAssetBalance(tx, portfolio.id, newTokenId);
        } else if (oldTokenId !== null) {
          await recalcAssetBalance(tx, portfolio.id, oldTokenId);
        } else if (newTokenId !== null) {
          await recalcAssetBalance(tx, portfolio.id, newTokenId);
        }
      }
    },
    { timeout: 15000 },
  );

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
      }
    },
    { timeout: 15000 },
  );
}
