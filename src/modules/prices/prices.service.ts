// POST /prices/refresh service — free-tier manual CMC price fetch.
//
// Flow: resolve symbols → call CMC → write to Redis price:<SYMBOL> (60s TTL)
// → return prices with source tag. Falls back to Redis cache then DB on CMC
// failure, surfacing partialFailure:true.

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { portfolioDerivedCacheKeys } from '../../lib/portfolio-cache-keys.js';
import { __internals as resolverInternals } from '../../lib/price-resolver.js';
import { getCatalogSymbols } from '../../lib/price-symbols.js';
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

  // retrofit-18/19: now that the fresh `price:<SYMBOL>` values are written, bust the caller's
  // read caches so the next GET /overview (and analytics) reflects the refresh immediately:
  //   - derived caches (portfolio_pnl + analytics_*) that computeDerived reads, AND
  //   - the per-user overview response cache (`overview:<userId>:*`) that wraps the whole payload.
  // Both layers must go: the response cache sits in front of the derived caches, so clearing
  // only the derived ones would still serve the pre-refresh response until its 60s TTL lapses.
  // Best-effort: a Redis/DB hiccup here must NOT fail an otherwise-successful refresh.
  await invalidateUserReadCaches(userId).catch((e: Error) =>
    console.error(`[prices] read-cache invalidation failed for user ${userId}:`, e.message),
  );

  return { prices, ...(partialFailure ? { partialFailure: true } : {}) };
}

// Delete the user's read caches so the next GET /overview recomputes against the fresh prices:
//   1. Every derived-cache key for each of the user's portfolios. Keys come from the shared
//      portfolioDerivedCacheKeys() helper (the same list transactions.service busts on CUD),
//      so this stays in sync as new derived caches are added there.
//   2. The per-user overview response cache (`overview:<userId>:*`, every days/txLimit variant).
async function invalidateUserReadCaches(userId: number): Promise<void> {
  const portfolios = await prisma.portfolio.findMany({
    where: { userId },
    select: { id: true },
  });
  const keys = portfolios.flatMap((p) => portfolioDerivedCacheKeys(p.id));
  if (keys.length > 0) await redis.del(...keys);

  const overviewKeys = await redis.keys(`overview:${userId}:*`);
  if (overviewKeys.length > 0) await redis.del(...overviewKeys);
}

// Exported for test injection
export function _setCmcProvider(p: CoinMarketCapTokenMetadataProvider): void {
  _cmcProvider = p;
}

// ---------------------------------------------------------------------------
// Source-visibility readout (retrofit-35) — GET /prices/debug
//
// Diagnostic, behind requireAuth: shows which source is pricing each token and lets
// you spot cross-source disagreements. Reads-only (no writes, no new deps): one mget
// of the canonical `price:<SYM>` + each per-exchange `price:<SYM>:<exchange>` entry,
// annotated with ageMs / stale (relative to the resolver's staleness window).
// ---------------------------------------------------------------------------

const { EXCHANGES, STALENESS_WINDOW_MS } = resolverInternals;
const DEBUG_BOARD_LIMIT = 50;

export interface PriceSourceDebug {
  price: number;
  ts: number;
  ageMs: number;
  stale: boolean;
}

export interface PriceSymbolDebug {
  symbol: string;
  canonical: { price: number; source: string; ts: number } | null;
  sources: Record<string, PriceSourceDebug>;
}

async function buildSymbolDebug(sym: string, now: number): Promise<PriceSymbolDebug> {
  const exchangeKeys = EXCHANGES.map((e) => `price:${sym}:${e}`);
  const raws = await redis.mget(`price:${sym}`, ...exchangeKeys);

  let canonical: PriceSymbolDebug['canonical'] = null;
  const canonRaw = raws[0];
  if (canonRaw) {
    try {
      const c = JSON.parse(canonRaw) as { price: number; source?: string; ts?: number };
      canonical = { price: c.price, source: c.source ?? 'unknown', ts: c.ts ?? 0 };
    } catch {
      // leave canonical null on a malformed entry
    }
  }

  const sources: Record<string, PriceSourceDebug> = {};
  EXCHANGES.forEach((exchange, i) => {
    const raw = raws[i + 1]; // offset by the leading canonical key
    if (!raw) return;
    try {
      const t = JSON.parse(raw) as { price: number; ts: number };
      const ageMs = now - t.ts;
      sources[exchange] = { price: t.price, ts: t.ts, ageMs, stale: ageMs > STALENESS_WINDOW_MS };
    } catch {
      // skip a malformed per-exchange entry
    }
  });

  return { symbol: sym, canonical, sources };
}

/**
 * Read-only price source board. With a symbol, return that symbol's canonical price + every
 * per-exchange source (ageMs/stale). Without one, return the first N catalog symbols as an
 * at-a-glance board. `now` is injectable for deterministic tests.
 */
export async function getPriceDebug(
  symbol: string | undefined,
  now: number = Date.now(),
): Promise<PriceSymbolDebug | { symbols: PriceSymbolDebug[] }> {
  if (symbol) {
    return buildSymbolDebug(symbol.toUpperCase(), now);
  }
  const board = [...getCatalogSymbols()].slice(0, DEBUG_BOARD_LIMIT);
  const symbols = await Promise.all(board.map((s) => buildSymbolDebug(s, now)));
  return { symbols };
}
