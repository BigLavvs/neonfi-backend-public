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
      });
    }
    return out;
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
