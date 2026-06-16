import type { Prisma } from '@prisma/client';

export type AssetWithToken = Prisma.AssetGetPayload<{
  include: { token: true };
}>;

export interface AssetDTO {
  id: number;
  portfolioId: number;
  tokenId: number;
  name: string;
  symbol: string;
  logoUrl: string | null;
  balance: number;
  price: number;
  value: number;
  portfolioPercentage: number;
  netDeposit: number;
  pnlAllTime: number;
  pnlAllTimeValue: number;
  createdAt: Date;
  updatedAt: Date;
}

// retrofit-15: `priceMap` overlays the live `price:<SYMBOL>` tick over the seeded
// currentPrice. Resolved once in the service (assets.service) and threaded in; a miss
// (or no map) falls back to currentPrice. Optional so non-overlay callers stay valid.
export function toAssetDTO(
  asset: AssetWithToken,
  portfolioTotalValue: number,
  priceMap?: Map<string, number>,
): AssetDTO {
  const balance = Number(asset.balance.toString());
  const price = priceMap?.get(asset.token.symbol) ?? Number(asset.token.currentPrice.toString());
  const value = balance * price;
  const netDeposit = Number(asset.netDeposit.toString());
  const portfolioPercentage = portfolioTotalValue > 0 ? (value / portfolioTotalValue) * 100 : 0;
  const pnlAllTimeValue = value - netDeposit;
  const pnlAllTime = netDeposit !== 0 ? ((value - netDeposit) / netDeposit) * 100 : 0;

  return {
    id: asset.id,
    portfolioId: asset.portfolioId,
    tokenId: asset.tokenId,
    name: asset.token.name,
    symbol: asset.token.symbol,
    logoUrl: asset.token.logoUrl ?? null,
    balance,
    price,
    value,
    portfolioPercentage,
    netDeposit,
    pnlAllTime,
    pnlAllTimeValue,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

export function computeTotalValue(
  assets: AssetWithToken[],
  priceMap?: Map<string, number>,
): number {
  return assets.reduce((sum, a) => {
    const balance = Number(a.balance.toString());
    const price = priceMap?.get(a.token.symbol) ?? Number(a.token.currentPrice.toString());
    return sum + balance * price;
  }, 0);
}
