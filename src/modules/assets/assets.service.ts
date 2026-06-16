import { prisma } from '../../lib/prisma.js';
import { getLivePriceMap } from '../../lib/live-price.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { seedAcquisitionInTx, invalidatePnlCache } from '../transactions/transactions.service.js';
import {
  findAllAssetsByPortfolioId,
  findAssetById,
  findAssetByPortfolioToken,
  updateAssetRow,
  deleteAssetRow,
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

export async function addAsset(
  userId: number,
  portfolio: PortfolioWithRelations,
  body: CreateAssetBody,
): Promise<AssetDTO> {
  assertManualPortfolio(portfolio);

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

  // retrofit-8: create the Asset and (when an acquisition amount is supplied) seed a
  // native `buy` transaction in ONE atomic $transaction, so balance and cost-basis
  // derive from the recalc model — one source of truth, accurate PnL via priceAtTime.
  // amount omitted → just the asset at balance 0 (back-compat with the {tokenId}-only
  // path). Validation above stays OUTSIDE the tx (cheap reads, fail fast).
  const seed = body.amount !== undefined && Number(body.amount) > 0;
  await prisma.$transaction(
    async (tx) => {
      await tx.asset.create({ data: { portfolioId: portfolio.id, tokenId: body.tokenId } });
      if (seed) {
        await seedAcquisitionInTx(tx, {
          portfolioId: portfolio.id,
          tokenId: body.tokenId,
          symbol: token.symbol,
          amount: body.amount!,
          priceAtTime: body.priceAtTime,
          timestamp: body.timestamp,
          notes: body.notes ?? null,
        });
      }
    },
    { timeout: 15000 },
  );

  await invalidatePnlCache(portfolio.id);

  // DTO read AFTER the commit (STOP-gate §6.1): balance/netDeposit now reflect the seed.
  const created = await findAssetByPortfolioToken(portfolio.id, body.tokenId);
  if (!created) throw new Error('Asset not found after creation');
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const priceMap = await getLivePriceMap(allAssets.map((a) => a.token.symbol));
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(created, totalValue, priceMap);
}

export async function listAssets(
  portfolio: PortfolioWithRelations,
  slug?: string,
): Promise<AssetDTO[]> {
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  // retrofit-15: overlay live price on the whole portfolio (totalValue spans every
  // asset, not just the slug-filtered display set).
  const priceMap = await getLivePriceMap(allAssets.map((a) => a.token.symbol));
  const totalValue = computeTotalValue(allAssets, priceMap);

  const display: AssetWithToken[] = slug
    ? allAssets.filter((a) => a.token.symbol.toLowerCase() === slug.toLowerCase())
    : allAssets;

  return display.map((a) => toAssetDTO(a, totalValue, priceMap));
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
  const priceMap = await getLivePriceMap(allAssets.map((a) => a.token.symbol));
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(asset, totalValue, priceMap);
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

  const asset: AssetWithToken =
    body.netDeposit !== undefined
      ? await updateAssetRow(assetId, { netDeposit: body.netDeposit })
      : existing;

  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const priceMap = await getLivePriceMap(allAssets.map((a) => a.token.symbol));
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(asset, totalValue, priceMap);
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

  await deleteAssetRow(assetId);
}
