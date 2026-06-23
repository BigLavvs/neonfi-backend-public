// Neonfi backend — canonical price reconciliation for auto-listed tokens (retrofit-71 C4).
//
// Auto-listed connected-wallet tokens (wallet-data/sync.ts) take their price straight from the
// balance provider (Moralis usdPrice), unverified — which was sometimes badly wrong (PEPU read
// $0.00009 vs a real $0.0000242, a 3.7× error). This module cross-checks a provider price
// against a CANONICAL feed (CoinGecko by contract address) and decides the price to trust plus a
// confidence flag the UI can surface:
//   - canonical found, provider within ~25%  → keep provider (confirmed)        → 'verified'
//   - canonical found, provider > 25% off     → use canonical (provider was off) → 'verified'
//   - canonical found, no provider price       → use canonical                   → 'verified'
//   - canonical absent (no listing/unreachable)→ keep provider                   → 'unverified'
//
// The source is INJECTABLE (_setCanonicalPriceSource) so tests stay hermetic; the default does a
// best-effort keyless CoinGecko call and never throws (any failure → null → 'unverified').

import { config } from '../../lib/config.js';

// CoinGecko "asset platform" id keyed by our chain slug. Unknown slugs → no canonical lookup.
const PLATFORM_BY_SLUG: Record<string, string> = {
  ethereum: 'ethereum',
  eth: 'ethereum',
  polygon: 'polygon-pos',
  'polygon-pos': 'polygon-pos',
  bsc: 'binance-smart-chain',
  'binance-smart-chain': 'binance-smart-chain',
  arbitrum: 'arbitrum-one',
  'arbitrum-one': 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  base: 'base',
  avalanche: 'avalanche',
};

export interface CanonicalPriceSource {
  // USD price for a token by chain slug + contract, or null when unknown/unreachable.
  byContract(slug: string, contract: string): Promise<number | null>;
}

// Default production source: CoinGecko /coins/{platform}/contract/{address} (keyless best-effort).
export const coinGeckoCanonicalSource: CanonicalPriceSource = {
  async byContract(slug, contract) {
    const platform = PLATFORM_BY_SLUG[slug.toLowerCase()];
    if (!platform) return null;
    // audit SEC #25: every platform here is EVM, so the (provider-sourced) contract must be a
    // 0x+40-hex address before we splice it into the CoinGecko URL. Reject anything else rather
    // than fetching an attacker-shaped path.
    const normalized = contract.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
    try {
      const url = `${config.COINGECKO_BASE}/coins/${platform}/contract/${normalized}`;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (config.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = config.COINGECKO_API_KEY;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { market_data?: { current_price?: { usd?: unknown } } };
      const p = data.market_data?.current_price?.usd;
      return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
    } catch {
      return null; // unreachable / rate-limited / malformed → caller flags 'unverified'
    }
  },
};

let activeSource: CanonicalPriceSource = coinGeckoCanonicalSource;
export function _setCanonicalPriceSource(s: CanonicalPriceSource): void {
  activeSource = s;
}
export function _resetCanonicalPriceSource(): void {
  activeSource = coinGeckoCanonicalSource;
}

// Provider prices beyond this relative distance from canonical are overridden by canonical.
export const PRICE_DEVIATION_THRESHOLD = 0.25;

export type PriceConfidence = 'verified' | 'unverified';

export interface ReconciledPrice {
  price: number | null; // price to persist; null only when there is nothing to write
  priceConfidence: PriceConfidence;
}

export async function reconcileTokenPrice(
  slug: string,
  contract: string | null,
  providerPrice: number | null,
): Promise<ReconciledPrice> {
  const canonical = contract ? await activeSource.byContract(slug, contract) : null;
  if (canonical == null) {
    // No canonical reference — keep whatever the provider gave (may be null) and flag it.
    return { price: providerPrice, priceConfidence: 'unverified' };
  }
  if (providerPrice == null || providerPrice <= 0) {
    return { price: canonical, priceConfidence: 'verified' };
  }
  const deviation = Math.abs(providerPrice - canonical) / canonical;
  return {
    price: deviation > PRICE_DEVIATION_THRESHOLD ? canonical : providerPrice,
    priceConfidence: 'verified',
  };
}
