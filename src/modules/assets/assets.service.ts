import { prisma } from '../../lib/prisma.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  findAllAssetsByPortfolioId,
  findAssetById,
  findAssetByPortfolioToken,
  createAssetRow,
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

  const asset = await createAssetRow({ portfolioId: portfolio.id, tokenId: body.tokenId });
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const totalValue = computeTotalValue(allAssets);
  return toAssetDTO(asset, totalValue);
}

export async function listAssets(
  portfolio: PortfolioWithRelations,
  slug?: string,
): Promise<AssetDTO[]> {
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const totalValue = computeTotalValue(allAssets);

  const display: AssetWithToken[] = slug
    ? allAssets.filter((a) => a.token.symbol.toLowerCase() === slug.toLowerCase())
    : allAssets;

  return display.map((a) => toAssetDTO(a, totalValue));
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
  const totalValue = computeTotalValue(allAssets);
  return toAssetDTO(asset, totalValue);
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
  const totalValue = computeTotalValue(allAssets);
  return toAssetDTO(asset, totalValue);
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
