// Neonfi backend — live-price read overlay (retrofit-15).
//
// Every value the app shows (portfolio totalValue, asset/token prices, overview
// allocation, analytics holdings) is computed from the SEEDED `Token.currentPrice`,
// which only moves on the 6-hourly CMC metadata sync (retrofit-14) — so prices are
// effectively frozen. Meanwhile a live cache already exists: writers SET
// `price:<SYMBOL> {price,change24h,timestamp} EX 60` on every tick (lib/coinbase.ts
// today; retrofit-16 adds Binance + Kraken to the same canonical key). Nothing on the
// read path consulted it.
//
// This helper closes that gap: each read path fetches the live map once and prefers
// `liveMap.get(sym) ?? Number(token.currentPrice)`. retrofit-15 is read-only and
// source-agnostic — it never WRITES `price:<SYMBOL>` (that's the writers' job) and
// doesn't care which exchange produced the canonical tick.

import { redis } from './redis.js';

// symbol → live USD price, for symbols that have a fresh canonical Redis tick.
// Misses are omitted (caller falls back to Token.currentPrice). Never throws —
// a Redis failure yields an empty map, so reads degrade to currentPrice.
export async function getLivePriceMap(symbols: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return new Map();
  const out = new Map<string, number>();
  try {
    const raw = await redis.mget(...unique.map((s) => `price:${s}`));
    unique.forEach((sym, i) => {
      const v = raw[i];
      if (!v) return;
      try {
        const p = (JSON.parse(v) as { price?: unknown }).price;
        if (typeof p === 'number' && p > 0) out.set(sym, p);
      } catch {
        /* skip malformed payload — caller falls back to currentPrice */
      }
    });
  } catch {
    /* Redis down/unreachable — return whatever we have (possibly empty) */
  }
  return out;
}
