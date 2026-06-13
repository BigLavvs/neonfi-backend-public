// POST /prices/refresh service — free-tier manual CMC price fetch.
//
// Flow: resolve symbols → call CMC → write to Redis price:<SYMBOL> (60s TTL)
// → return prices with source tag. Falls back to Redis cache then DB on CMC
// failure, surfacing partialFailure:true.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { CoinMarketCapTokenMetadataProvider } from '../tokens/sync/coinmarketcap-provider.js';

const PRICE_TTL_S = 60;

export interface PriceEntry {
  symbol: string;
  price: number | null;
  change24h: number | null;
  source: 'live' | 'cache' | 'db';
}

export interface RefreshResult {
  prices: PriceEntry[];
  partialFailure?: boolean;
}

let _cmcProvider: CoinMarketCapTokenMetadataProvider | null = null;

function getCmcProvider(): CoinMarketCapTokenMetadataProvider {
  if (!_cmcProvider) {
    _cmcProvider = new CoinMarketCapTokenMetadataProvider(config.COINMARKETCAP_API_KEY);
  }
  return _cmcProvider;
}

export async function resolveSymbolsForUser(
  userId: number,
  requested: string[] | undefined,
): Promise<string[]> {
  if (requested && requested.length > 0) {
    // Validate requested symbols exist in the Token table
    const found = await prisma.token.findMany({
      where: { symbol: { in: requested } },
      select: { symbol: true },
    });
    const foundSet = new Set(found.map((t) => t.symbol));
    const unknown = requested.find((s) => !foundSet.has(s));
    if (unknown) {
      throw Object.assign(new Error(`Unknown symbol: ${unknown}`), { code: 'UNKNOWN_SYMBOL' });
    }
    return requested.slice(0, 5);
  }

  // Derive from user's portfolio assets (first 5 by createdAt asc)
  const assets = await prisma.asset.findMany({
    where: {
      portfolio: { userId },
    },
    include: { token: true },
    orderBy: { createdAt: 'asc' },
  });

  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const a of assets) {
    if (!seen.has(a.token.symbol)) {
      seen.add(a.token.symbol);
      symbols.push(a.token.symbol);
      if (symbols.length === 5) break;
    }
  }
  return symbols;
}

export async function refreshPrices(
  userId: number,
  symbols: string[],
): Promise<RefreshResult> {
  if (symbols.length === 0) {
    return { prices: [] };
  }

  let cmcMap: Map<string, { price: number; change24h: number }> | null = null;
  let partialFailure = false;

  try {
    cmcMap = await getCmcProvider().fetchPrices(symbols);
  } catch {
    partialFailure = true;
  }

  const prices: PriceEntry[] = [];

  for (const symbol of symbols) {
    if (cmcMap && cmcMap.has(symbol)) {
      const { price, change24h } = cmcMap.get(symbol)!;
      const payload = JSON.stringify({ price, change24h, timestamp: Date.now() });
      await redis.set(`price:${symbol}`, payload, 'EX', PRICE_TTL_S);
      prices.push({ symbol, price, change24h, source: 'live' });
    } else {
      // Fallback: Redis cache
      const cached = await redis.get(`price:${symbol}`);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { price: number; change24h: number };
          prices.push({ symbol, price: parsed.price, change24h: parsed.change24h, source: 'cache' });
          partialFailure = true;
          continue;
        } catch {
          // fall through to DB
        }
      }
      // Fallback: DB Token.currentPrice
      const token = await prisma.token.findUnique({
        where: { symbol },
        select: { currentPrice: true },
      });
      const dbPrice = token ? parseFloat(token.currentPrice.toString()) : null;
      prices.push({ symbol, price: dbPrice, change24h: null, source: 'db' });
      partialFailure = true;
    }
  }

  return { prices, ...(partialFailure ? { partialFailure: true } : {}) };
}

// Exported for test injection
export function _setCmcProvider(p: CoinMarketCapTokenMetadataProvider): void {
  _cmcProvider = p;
}
