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
