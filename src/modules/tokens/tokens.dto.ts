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
  // retrofit-71 (C4): 'verified' = price confirmed against a canonical feed; 'unverified' = an
  // auto-listed wallet token whose price couldn't be cross-checked (UI marks/excludes it);
  // null = CMC catalog row (trusted by default).
  priceConfidence: string | null;
}

export interface TokenDetailDTO extends TokenListDTO {
  marketCap: number | null;
  updatedAt: Date;
}

// retrofit-21: GET /tokens/:id/history response. `points` is the daily price series
// (oldest→newest, 'YYYY-MM-DD'), with a trailing "now" point overlaid from the live
// price when the latest snapshot predates today. `ath`/`atl` are the high/low of price
// SINCE TRACKING BEGAN (min/max over all snapshots folded with the live price), NOT a
// true all-time high/low — CoinMarketCap's quote doesn't expose ATH/ATL, so this is the
// honest MVP semantics. Built in tokens.service (live overlay + aggregate live there).
export interface TokenPricePointDTO {
  date: string;
  price: number;
}

export interface TokenHistoryDTO {
  points: TokenPricePointDTO[];
  ath: number;
  atl: number;
  // retrofit-71 (C5): ath/atl are the high/low SINCE TRACKING BEGAN, not a true all-time
  // extreme — 'tracked' tells the UI to label them "High/Low (tracked)"/"1Y High/Low" rather
  // than "All-Time". ('all-time' is reserved for when a real provider ATH/ATL is stored.)
  athAtlBasis: 'tracked' | 'all-time';
  // retrofit-71 (C6): true when the real daily series is too short to chart as history (e.g. a
  // freshly auto-listed token with ~2 points). The UI shows "limited history" instead of drawing
  // a fabricated multi-point line labelled "1M"/"1Y".
  limitedHistory: boolean;
}

// retrofit-15: `livePrice` overlays the fresh `price:<SYMBOL>` tick over the seeded
// currentPrice. Resolved in tokens.service and passed per-token; undefined (no tick)
// falls back to currentPrice. Optional so non-overlay callers stay valid.
export function toTokenListDTO(token: Token, livePrice?: number): TokenListDTO {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    logoUrl: token.logoUrl,
    currentPrice: livePrice ?? Number(token.currentPrice.toString()),
    rank: token.rank,
    priceConfidence: token.priceConfidence,
  };
}

export function toTokenDetailDTO(token: Token, livePrice?: number): TokenDetailDTO {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    logoUrl: token.logoUrl,
    currentPrice: livePrice ?? Number(token.currentPrice.toString()),
    rank: token.rank,
    priceConfidence: token.priceConfidence,
    marketCap: token.marketCap !== null ? Number(token.marketCap.toString()) : null,
    updatedAt: token.updatedAt,
  };
}
