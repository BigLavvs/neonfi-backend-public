// CoinMarketCap token metadata + price adapter.
//
// Implements TokenMetadataProvider (for the Stage 9B background sync) and
// exposes a separate fetchPrices() method for the Stage 10A /prices/refresh
// endpoint. Both call the same CMC v2/cryptocurrency/quotes/latest endpoint,
// which is symbol-native and returns price, marketCap, rank, and 24h change
// in a single batch request.
//
// COINMARKETCAP_API_KEY is optional at boot; when absent the adapter returns
// empty Maps and logs a warning instead of crashing.

import type { TokenMetadataProvider, TokenMetadata } from './provider.js';

const CMC_URL = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest';
const MAX_SYMBOLS_PER_CALL = 50;
// retrofit-34: market-cap-ranked listings endpoint — used to INGEST a real catalog
// (top-N coins), distinct from the symbol-native quotes/latest the sync path uses.
const CMC_LISTINGS_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';

// retrofit-34: one ranked listing row, normalized to Token-table column shapes
// (decimal strings, nullable rank/marketCap/logoUrl).
export interface TopToken {
  symbol: string;
  name: string;
  rank: number | null;
  currentPrice: string;
  marketCap: string | null;
  logoUrl: string | null;
  // retrofit-39: 24h % change persisted on catalog ingest (cold-cache wallet-badge fallback).
  change24h: number | null;
}

interface CmcListing {
  id: number;
  name: string;
  symbol: string;
  cmc_rank: number | null;
  quote: { USD: { price: number | null; market_cap: number | null; percent_change_24h?: number | null } };
}

interface CmcQuoteUsd {
  price: number;
  percent_change_24h: number;
  market_cap: number | null;
}

interface CmcEntry {
  cmc_rank: number | null;
  quote: { USD: CmcQuoteUsd };
}

interface CmcResponse {
  data: Record<string, CmcEntry[]>;
}

export interface PriceData {
  price: number;
  change24h: number;
}

export class CoinMarketCapTokenMetadataProvider implements TokenMetadataProvider {
  readonly name = 'coinmarketcap';

  constructor(private readonly apiKey: string | undefined) {}

  private async _fetch(symbols: string[]): Promise<CmcResponse | null> {
    if (!this.apiKey) {
      console.warn('[cmc-provider] COINMARKETCAP_API_KEY is not set — skipping fetch');
      return null;
    }

    // CMC accepts up to 50 symbols per call. The previous .slice(0, 50) silently
    // dropped everything past the 50th symbol (A23); batch loop covers the full
    // catalogue and merges each batch's data into one aggregated response.
    const aggregated: CmcResponse = { data: {} };

    for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_CALL) {
      const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_CALL).join(',');
      const url = `${CMC_URL}?symbol=${encodeURIComponent(batch)}`;

      const res = await fetch(url, {
        headers: { 'X-CMC_PRO_API_KEY': this.apiKey, Accept: 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`CMC HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }

      const body = (await res.json()) as CmcResponse;
      Object.assign(aggregated.data, body.data);
    }

    return aggregated;
  }

  async fetchMetadata(symbols: string[]): Promise<Map<string, TokenMetadata>> {
    if (symbols.length === 0) return new Map();

    let body: CmcResponse | null;
    try {
      body = await this._fetch(symbols);
    } catch (e) {
      console.error('[cmc-provider] fetchMetadata failed:', e);
      return new Map();
    }

    if (!body) return new Map();

    const out = new Map<string, TokenMetadata>();
    for (const symbol of symbols) {
      const entries = body.data[symbol];
      if (!entries?.length) continue;
      // Pick the entry with the highest market_cap when there are multiple listings
      const entry = entries.reduce((best, cur) =>
        (cur.quote.USD.market_cap ?? 0) > (best.quote.USD.market_cap ?? 0) ? cur : best,
      );
      const usd = entry.quote.USD;
      if (usd?.price == null) continue; // CMC returned no price for this symbol — skip, don't crash the batch
      out.set(symbol, {
        symbol,
        currentPrice: usd.price.toFixed(8),
        marketCap: usd.market_cap != null ? usd.market_cap.toFixed(2) : null,
        rank: entry.cmc_rank ?? null,
        change24h: usd.percent_change_24h ?? null, // retrofit-39
      });
    }
    return out;
  }

  /**
   * retrofit-34: fetch the CMC top-N coins by market cap (listings/latest). Used by the
   * catalog-ingest routine to INSERT real content into the Token table — unlike
   * fetchMetadata/fetchPrices, which are symbol-native and only refresh existing rows.
   * Dedupes duplicate tickers (CMC reuses symbols across coins) keeping the highest
   * market cap; builds logoUrl from CMC's public static CDN keyed by coin id; skips
   * null-price rows. Returns [] (no throw) when no API key is configured.
   */
  async fetchTopTokens(limit: number): Promise<TopToken[]> {
    if (!this.apiKey) {
      console.warn('[cmc-provider] no API key — skipping fetchTopTokens');
      return [];
    }
    const url = `${CMC_LISTINGS_URL}?start=1&limit=${limit}&convert=USD&sort=market_cap`;
    const res = await fetch(url, {
      headers: { 'X-CMC_PRO_API_KEY': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`CMC listings HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json()) as { data: CmcListing[] };

    const best = new Map<string, TopToken & { _mc: number }>();
    for (const c of body.data ?? []) {
      const usd = c.quote?.USD;
      if (!usd || usd.price == null) continue; // no price → unusable
      const mc = usd.market_cap ?? 0;
      const prev = best.get(c.symbol);
      if (prev && prev._mc >= mc) continue; // keep the higher-market-cap listing for a dup ticker
      best.set(c.symbol, {
        symbol: c.symbol,
        name: c.name,
        rank: c.cmc_rank ?? null,
        currentPrice: usd.price.toFixed(8),
        marketCap: usd.market_cap != null ? usd.market_cap.toFixed(2) : null,
        logoUrl: `https://s2.coinmarketcap.com/static/img/coins/64x64/${c.id}.png`,
        change24h: usd.percent_change_24h ?? null, // retrofit-39
        _mc: mc,
      });
    }
    return [...best.values()].map(({ _mc, ...t }) => t);
  }

  async fetchPrices(symbols: string[]): Promise<Map<string, PriceData>> {
    if (symbols.length === 0) return new Map();

    let body: CmcResponse | null;
    try {
      body = await this._fetch(symbols);
    } catch (e) {
      console.error('[cmc-provider] fetchPrices failed:', e);
      throw e;
    }

    if (!body) return new Map();

    const out = new Map<string, PriceData>();
    for (const symbol of symbols) {
      const entries = body.data[symbol];
      if (!entries?.length) continue;
      const entry = entries.reduce((best, cur) =>
        (cur.quote.USD.market_cap ?? 0) > (best.quote.USD.market_cap ?? 0) ? cur : best,
      );
      const usd = entry.quote.USD;
      if (usd?.price == null) continue; // CMC returned no price for this symbol — skip, don't emit a null price
      out.set(symbol, { price: usd.price, change24h: usd.percent_change_24h });
    }
    return out;
  }
}
