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
export async function createCrossPortfolioTransfer(
  source: PortfolioWithRelations,
  body: TransferBody,
): Promise<{
  transferGroupId: string;
  source: TransactionDetailDTO;
  dest: TransactionDetailDTO;
}> {
  // 1. Source must be a manual portfolio (connected portfolios are webhook-only).
  assertManualPortfolio(source);

  // 2. Resolve + validate dest: must exist, be owned by the same user, be manual, and
  //    differ from the source. Not-found / not-owned collapse to one 403 (don't leak
  //    the existence of other users' portfolios); same-id and connected-dest are 400.
  const dest = await findPortfolioById(body.destPortfolioId);
  if (!dest || dest.userId !== source.userId) {
    throw new TransactionError(403, 'DEST_NOT_FOUND', 'Destination portfolio not found or access denied');
  }
  if (dest.id === source.id) {
    throw new TransactionError(
      400,
      'INVALID_TRANSFER_TARGET',
      'Cannot transfer to the same portfolio',
    );
  }
  if (dest.type.name === 'connected') {
    throw new TransactionError(
      400,
      'INVALID_TRANSFER_TARGET',
      'Destination must be a manual portfolio',
    );
  }

  // 3. Resolve token by symbol.
  const token = await prisma.token.findUnique({ where: { symbol: body.symbol } });
  if (!token) {
    throw new TransactionError(400, 'UNKNOWN_TOKEN_SYMBOL', `Unknown token symbol: ${body.symbol}`);
  }

  // 4. Source asset must exist and hold enough balance.
  const sourceAsset = await findAssetByPortfolioToken(source.id, token.id);
  const balance = sourceAsset ? Number(sourceAsset.balance.toString()) : 0;
  const amount = Number(body.amount);
  if (!sourceAsset || balance < amount) {
    throw new TransactionError(
      400,
      'INSUFFICIENT_BALANCE',
      'Source portfolio has insufficient balance for this transfer',
    );
  }

  // 5. Cost-basis carry: per-unit basis = netDeposit / balance (guard balance > 0).
  //    usdValue = amount × netDeposit / balance, computed with .toFixed(8) so the
  //    conserved-basis invariant is exact at the persisted precision. Both legs use
  //    this same usdValue → basis conserved, no fake PnL (§8.2).
  const netDeposit = Number(sourceAsset.netDeposit.toString());
  const usdValue = balance > 0 ? ((amount * netDeposit) / balance).toFixed(8) : '0.00000000';

  // 6. Static seed rows resolved via the global prisma client (low in-tx query count),
  //    like seedAcquisitionInTx / createTransactionFromWebhook; the legs + details +
  //    recalcs are written via the tx client so both portfolios commit atomically.
  const [nativeType, sellDir, buyDir] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'sell' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } }),
  ]);

  const transferGroupId = randomUUID();
  const ts = body.timestamp ? new Date(body.timestamp) : new Date();
  const notes = body.notes ?? null;

  const { sourceTxId, destTxId } = await prisma.$transaction(
    async (tx) => {
      // Ensure the dest asset exists — mirror the webhook auto-create. The dest
      // plan-rank is intentionally NOT re-checked: the user already holds this token
      // in the source portfolio, so the transfer adds no NEW distinct holding to gate.
      const destAsset = await tx.asset.findUnique({
        where: { portfolioId_tokenId: { portfolioId: dest.id, tokenId: token.id } },
      });
      if (!destAsset) {
        await tx.asset.create({
          data: { portfolioId: dest.id, tokenId: token.id, balance: '0', netDeposit: '0' },
        });
      }

      // Source leg: `sell` (drops source balance + netDeposit).
      const sourceLeg = await createTransactionRow(tx, {
        portfolioId: source.id,
        typeId: nativeType.id,
        directionId: sellDir.id,
        timestamp: ts,
        notes,
        transferGroupId,
      });
      await createNativeDetail(tx, sourceLeg.id, {
        amount: body.amount,
        symbol: body.symbol,
        usdValue,
        priceAtTime: null,
      });

      // Dest leg: `buy` (raises dest balance + netDeposit) with the SAME usdValue.
      const destLeg = await createTransactionRow(tx, {
        portfolioId: dest.id,
        typeId: nativeType.id,
        directionId: buyDir.id,
        timestamp: ts,
        notes,
        transferGroupId,
      });
      await createNativeDetail(tx, destLeg.id, {
        amount: body.amount,
        symbol: body.symbol,
        usdValue,
        priceAtTime: null,
      });

      // Recalc both portfolios (asset balance/netDeposit, then portfolio netDeposit).
      await recalcAssetBalance(tx, source.id, token.id);
      await recalcPortfolioNetDeposit(tx, source.id);
      await recalcAssetBalance(tx, dest.id, token.id);
      await recalcPortfolioNetDeposit(tx, dest.id);

      return { sourceTxId: sourceLeg.id, destTxId: destLeg.id };
    },
    { timeout: 15000 },
  );

  // 7. Invalidate derived caches for BOTH portfolios after commit.
  await invalidatePnlCache(source.id);
  await invalidatePnlCache(dest.id);

  // 8. Return both leg DTOs.
  const [sourceFull, destFull] = await Promise.all([
    findTransactionById(sourceTxId),
    findTransactionById(destTxId),
  ]);
  if (!sourceFull || !destFull) throw new Error('Transfer legs not found after creation');
  return {
    transferGroupId,
    source: toTransactionDetailDTO(sourceFull),
    dest: toTransactionDetailDTO(destFull),
  };
}

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------

// retrofit-49 (#6): resolve each row's token logo from the Token catalog by symbol, in a
// single `IN` query, then map symbol → logoUrl. nft rows (no symbol) get null. Returns the
// mapper input so a row with no matching catalog entry simply renders without an image.


