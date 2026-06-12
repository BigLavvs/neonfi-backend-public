// Neonfi backend — Token DTOs (Stage 6).
//
// Decimal fields (currentPrice, marketCap) are serialized as JS number via
// Number(decimal.toString()). This matches the frontend mock conventions and
// the architecture rep's numeric notation. Precision trade-off: IEEE 754 double
// has ~15 significant digits; currentPrice has up to 8 decimals (20,8 schema),
// which is safe for display purposes. Stage 9 sync should keep prices in a
// range where this doesn't matter.

import type { Token } from '@prisma/client';

export interface TokenListDTO {
  id: number;
  name: string;
  symbol: string;
  logoUrl: string | null;
  currentPrice: number;
  rank: number | null;
}

export interface TokenDetailDTO extends TokenListDTO {
  marketCap: number | null;
  updatedAt: Date;
}

export function toTokenListDTO(token: Token): TokenListDTO {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    logoUrl: token.logoUrl,
    currentPrice: Number(token.currentPrice.toString()),
    rank: token.rank,
  };
}

export function toTokenDetailDTO(token: Token): TokenDetailDTO {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    logoUrl: token.logoUrl,
    currentPrice: Number(token.currentPrice.toString()),
    rank: token.rank,
    marketCap: token.marketCap !== null ? Number(token.marketCap.toString()) : null,
    updatedAt: token.updatedAt,
  };
}
