// Neonfi backend — Zerion read-side wallet provider (retrofit-60).
//
// VALUE-HISTORY ONLY: Zerion's `GET /v1/wallets/{address}/charts/{period}` returns the wallet's
// whole USD value curve across ALL chains in ONE call (probe-confirmed: `data.attributes.points`
// = [[unixSeconds, value], …], ~398 points spanning ~4 years at ~3.75-day cadence for the test
// wallet). That makes it the most efficient multi-year source, so it sits ahead of GoldRush in
// the provider chain for getValueHistory. It does NOT implement getSummary (current balances come
// from Moralis/GoldRush/etc.) — getSummary returns 'error' instantly so the summary loop skips it.
//
// Auth: HTTP Basic with the API key as the username and an empty password →
// `Authorization: Basic base64(KEY + ':')` (probe-confirmed).
//
// Error handling (retrofit-60 standard): every non-2xx (4xx AND 5xx) + network/parse error
// returns null so the orchestrator falls through to the next provider — never throws.

import type { ProviderResult, WalletDataProvider } from '../types.js';

// Zerion charts are wallet-wide (cross-chain), so the chain slug only gates WHETHER we consult
// Zerion, not the request. Support the EVM chains the app offers; Solana is out (Zerion chart
// coverage there is unverified — fall through to other providers).
const ZERION_EVM_SLUGS = new Set([
  'eth', 'polygon', 'bnb', 'arbitrum', 'optimism', 'base', 'avalanche', 'fantom', 'linea',
  'zksync', 'gnosis', 'cronos', 'mantle',
]);

interface ZerionChartResponse {
  data?: { attributes?: { points?: Array<[number, number]> } };
}

export class ZerionWalletProvider implements WalletDataProvider {
  readonly name = 'zerion';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return ZERION_EVM_SLUGS.has(chainSlug);
  }

  // Value-history-only provider — never produces a current-balance summary.
  async getSummary(): Promise<ProviderResult> {
    return { status: 'error' };
  }

  // One-call multi-year USD value curve, returned ASC by date and clamped to the last `days`.
  // Zerion points are [unixSeconds, usdValue]; we collapse to one value per calendar day (the
  // last point of each day wins). null on any non-2xx / network / parse failure.
  async getValueHistory(
    address: string,
    chainSlug: string,
    days: number,
  ): Promise<Array<{ date: string; value: number }> | null> {
    if (!this.isConfigured() || !this.supportsChain(chainSlug)) return null;
    try {
      // period=max → the deepest range Zerion has for the wallet (one call).
      const url = `https://api.zerion.io/v1/wallets/${address}/charts/max?currency=usd`;
      const auth = 'Basic ' + Buffer.from(`${this.apiKey!}:`).toString('base64');
      const res = await fetch(url, { headers: { Authorization: auth, accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as ZerionChartResponse;
      const points = json.data?.attributes?.points;
      if (!Array.isArray(points) || points.length === 0) return null;

      const cutoffMs = Date.now() - days * 86400 * 1000;
      const byDate = new Map<string, number>();
      for (const p of points) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const ms = p[0] * 1000;
        if (ms < cutoffMs) continue;
        const value = Number(p[1]);
        if (!Number.isFinite(value)) continue;
        byDate.set(new Date(ms).toISOString().slice(0, 10), value); // last point of the day wins
      }
      if (byDate.size === 0) return null;
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, value]) => ({ date, value }));
    } catch (e) {
      console.error('[wallet-data] zerion getValueHistory failed', (e as Error).message);
      return null;
    }
  }
}
