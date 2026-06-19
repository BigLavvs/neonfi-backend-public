import { prisma } from '../../lib/prisma.js';
import { getLivePriceMap, getLiveChangeMap } from '../../lib/live-price.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { invalidatePnlCache } from '../transactions/transactions.service.js';
import { recalcAssetBalance, recalcPortfolioNetDeposit } from '../transactions/recalc.js';
import { findTokenPriceSnapshotOnOrBefore } from '../tokens/tokens.repository.js';
import {
  findAllAssetsByPortfolioId,
  findAssetById,
  findAssetByPortfolioToken,
  updateAssetRow,
} from './assets.repository.js';
import { toAssetDTO, computeTotalValue, type AssetWithToken, type AssetDTO } from './assets.dto.js';
import type { CreateAssetBody, UpdateAssetBody } from './assets.schemas.js';

export class AssetError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

function assertManualPortfolio(portfolio: PortfolioWithRelations): void {
  if (portfolio.type.name === 'connected') {
    throw new AssetError(
      403,
      'CONNECTED_PORTFOLIO_READ_ONLY',
      'Assets in connected portfolios are read-only',
    );
  }
}

// retrofit-27 §5: create an OPENING position (a pre-existing holding, NOT a trade). Sets
// the Asset.opening* fields; recalc then derives balance + avgCost/costBasis from the
// opening lot. (retrofit-44 adds PATCH for opening fields.)
export async function addAsset(
  userId: number,
  portfolio: PortfolioWithRelations,
  body: CreateAssetBody,
): Promise<AssetDTO> {
  assertManualPortfolio(portfolio);

  const balanceNum = Number(body.balance);
  if (!(balanceNum > 0)) {
    throw new AssetError(400, 'INVALID_BALANCE', 'Opening balance must be greater than 0');
  }

  const token = await prisma.token.findUnique({ where: { id: body.tokenId } });
  if (!token) {
    throw new AssetError(400, 'INVALID_TOKEN', 'Token not found');
  }

  const effectivePlan = await getEffectivePlan(userId);
  if (effectivePlan === 'free' && (token.rank === null || token.rank > 10)) {
    throw new AssetError(
      403,
      'PLAN_LIMIT_REACHED',
      'Your plan only allows tokens ranked in the top 10',
      { tokenSymbol: token.symbol, plan: 'free', requiredRank: 10 },
    );
  }

  const existing = await findAssetByPortfolioToken(portfolio.id, body.tokenId);
  if (existing) {
    throw new AssetError(409, 'ASSET_ALREADY_EXISTS', 'This token is already in the portfolio');
  }

  // Resolve the opening cost basis per the cost mode (all reads OUTSIDE the tx — fail fast).
  let openingCostBasis: string | null = null;
  let openingAt: Date | null = null;
  if (body.cost.mode === 'avg') {
    openingCostBasis = (balanceNum * Number(body.cost.avgCost)).toFixed(8);
  } else if (body.cost.mode === 'historical') {
    const asOf = new Date(body.cost.date);
    const snap = await findTokenPriceSnapshotOnOrBefore(body.tokenId, asOf);
    if (!snap) {
      throw new AssetError(
        400,
        'PRICE_HISTORY_UNAVAILABLE',
        'No price history on or before the requested date — choose average or no cost',
        { tokenSymbol: token.symbol, date: body.cost.date },
      );
    }
    openingCostBasis = (balanceNum * snap.price).toFixed(8);
    openingAt = asOf;
  }
  // mode === 'none' → openingCostBasis stays null (cost-unknown holding).

  await prisma.$transaction(
    async (tx) => {
      await tx.asset.create({
        data: {
          portfolioId: portfolio.id,
          tokenId: body.tokenId,
          openingBalance: body.balance,
          openingCostBasis,
          openingAt,
        },
      });
      // recalc seeds balance = openingBalance and avgCost/costBasis from the opening lot
      // (no transactions yet); netDeposit stays 0 (opening is not a deposit).
      await recalcAssetBalance(tx, portfolio.id, body.tokenId);
      await recalcPortfolioNetDeposit(tx, portfolio.id);
    },
    { timeout: 15000 },
  );

  await invalidatePnlCache(portfolio.id);

  // DTO read AFTER the commit (STOP-gate §6.1): balance/avgCost/costBasis reflect the opening.
  const created = await findAssetByPortfolioToken(portfolio.id, body.tokenId);
  if (!created) throw new Error('Asset not found after creation');
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const symbols = allAssets.map((a) => a.token.symbol);
  const [priceMap, changeMap] = await Promise.all([
    getLivePriceMap(symbols),
    getLiveChangeMap(symbols),
  ]);
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(created, totalValue, priceMap, changeMap);
}

export async function listAssets(
  portfolio: PortfolioWithRelations,
  slug?: string,
): Promise<AssetDTO[]> {
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  // retrofit-15: overlay live price on the whole portfolio (totalValue spans every
  // asset, not just the slug-filtered display set). retrofit-39: same for the 24h change.
  const symbols = allAssets.map((a) => a.token.symbol);
  const [priceMap, changeMap] = await Promise.all([
    getLivePriceMap(symbols),
    getLiveChangeMap(symbols),
  ]);
  const totalValue = computeTotalValue(allAssets, priceMap);

  const display: AssetWithToken[] = slug
    ? allAssets.filter((a) => a.token.symbol.toLowerCase() === slug.toLowerCase())
    : allAssets;

  return display.map((a) => toAssetDTO(a, totalValue, priceMap, changeMap));
}

export async function getAsset(
  portfolio: PortfolioWithRelations,
  assetId: number,
): Promise<AssetDTO> {
  const asset = await findAssetById(assetId);
  if (!asset || asset.portfolioId !== portfolio.id) {
    throw new AssetError(404, 'ASSET_NOT_FOUND', 'Asset not found');
  }

  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const symbols = allAssets.map((a) => a.token.symbol);
  const [priceMap, changeMap] = await Promise.all([
    getLivePriceMap(symbols),
    getLiveChangeMap(symbols),
  ]);
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(asset, totalValue, priceMap, changeMap);
}

export async function updateAsset(
  portfolio: PortfolioWithRelations,
  assetId: number,
  body: UpdateAssetBody,
): Promise<AssetDTO> {
  assertManualPortfolio(portfolio);

  const existing = await findAssetById(assetId);
  if (!existing || existing.portfolioId !== portfolio.id) {
    throw new AssetError(404, 'ASSET_NOT_FOUND', 'Asset not found');
  }

  const isOpeningEdit = body.balance !== undefined || body.cost !== undefined;

  if (isOpeningEdit) {
    // retrofit-44: edit the opening position in place, then recalc atomically.
    const balanceStr = body.balance ?? existing.openingBalance.toString();
    const balanceNum = Number(balanceStr);
    if (!(balanceNum > 0)) {
      throw new AssetError(400, 'INVALID_BALANCE', 'Opening balance must be greater than 0');
    }

    let openingCostBasis: string | null;
    let openingAt: Date | null;

    if (body.cost === undefined) {
      // Balance-only edit: rescale cost basis at the prior per-unit avg so per-unit avg is unchanged.
      const prevBal = Number(existing.openingBalance.toString());
      const prevBasis =
        existing.openingCostBasis !== null ? Number(existing.openingCostBasis.toString()) : null;
      const perUnit = prevBasis !== null && prevBal > 0 ? prevBasis / prevBal : null;
      openingCostBasis = perUnit !== null ? (balanceNum * perUnit).toFixed(8) : null;
      openingAt = existing.openingAt;
    } else if (body.cost.mode === 'avg') {
      openingCostBasis = (balanceNum * Number(body.cost.avgCost)).toFixed(8);
      openingAt = null;
    } else if (body.cost.mode === 'historical') {
      const asOf = new Date(body.cost.date);
      const snap = await findTokenPriceSnapshotOnOrBefore(existing.tokenId, asOf);
      if (!snap) {
        throw new AssetError(
          400,
          'PRICE_HISTORY_UNAVAILABLE',
          'No price history on or before the requested date — choose average or no cost',
          { date: body.cost.date },
        );
      }
      openingCostBasis = (balanceNum * snap.price).toFixed(8);
      openingAt = asOf;
    } else {
      openingCostBasis = null;
      openingAt = null;
    }

    await prisma.$transaction(
      async (tx) => {
        await updateAssetRow(assetId, { openingBalance: balanceStr, openingCostBasis, openingAt }, tx);
        await recalcAssetBalance(tx, portfolio.id, existing.tokenId);
        await recalcPortfolioNetDeposit(tx, portfolio.id);
      },
      { timeout: 15000 },
    );
    await invalidatePnlCache(portfolio.id);
  } else if (body.netDeposit !== undefined) {
    await updateAssetRow(assetId, { netDeposit: body.netDeposit });
  }

  // DTO read AFTER commit (mirror addAsset): balance/avgCost/costBasis reflect the new opening.
  const fresh = await findAssetById(assetId);
  if (!fresh) throw new Error('Asset not found after update');
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const symbols = allAssets.map((a) => a.token.symbol);
  const [priceMap, changeMap] = await Promise.all([
    getLivePriceMap(symbols),
    getLiveChangeMap(symbols),
  ]);
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(fresh, totalValue, priceMap, changeMap);
}

export async function removeAsset(
  portfolio: PortfolioWithRelations,
  assetId: number,
): Promise<void> {
  assertManualPortfolio(portfolio);

  const existing = await findAssetById(assetId);
  if (!existing || existing.portfolioId !== portfolio.id) {
    throw new AssetError(404, 'ASSET_NOT_FOUND', 'Asset not found');
  }

  // retrofit-69 (R39): an opening lot's cost basis now lives in Portfolio.netDeposit, so
  // deleting the asset must subtract that contribution — recompute the portfolio total once
  // the row is gone (create adds, delete subtracts, edit applies the delta).
  await prisma.$transaction(
    async (tx) => {
      await tx.asset.delete({ where: { id: assetId } });
      await recalcPortfolioNetDeposit(tx, portfolio.id);
    },
    { timeout: 15000 },
  );
  await invalidatePnlCache(portfolio.id);
}
