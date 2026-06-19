// Neonfi backend — Mobula read-side wallet provider (retrofit-60).
//
// VALUE-HISTORY ONLY: Mobula's `GET /api/1/wallet/history?wallet=&from=&to=` returns the wallet's
// USD balance curve in ONE call (probe-confirmed: `data.balance_history` = [[tsMs, value], …],
// ~daily cadence spanning the requested range — 3 years for the test wallet). Sits alongside
// Zerion in the value-history chain (ahead of GoldRush). It does NOT implement getSummary.
//
// Auth: the raw API key in the `Authorization` header (probe-confirmed — no Bearer/Basic prefix).
//
// Error handling (retrofit-60 standard): any non-2xx (4xx AND 5xx) + network/parse error → null,
// so the orchestrator falls through to the next provider; never throws.

import type { ProviderResult, WalletDataProvider } from '../types.js';

const MOBULA_EVM_SLUGS = new Set([
  'eth', 'polygon', 'bnb', 'arbitrum', 'optimism', 'base', 'avalanche', 'fantom', 'linea',
  'zksync', 'gnosis', 'cronos', 'mantle',
]);

interface MobulaHistoryResponse {
  data?: { balance_history?: Array<[number, number]> };
}

export class MobulaWalletProvider implements WalletDataProvider {
  readonly name = 'mobula';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return MOBULA_EVM_SLUGS.has(chainSlug);
  }

  async getSummary(): Promise<ProviderResult> {
    return { status: 'error' };
  }

  // One-call USD balance curve over [now-days, now], returned ASC by date (one value per day,
  // last wins). null on any non-2xx / network / parse failure.
  async getValueHistory(
    address: string,
    chainSlug: string,
    days: number,
  ): Promise<Array<{ date: string; value: number }> | null> {
    if (!this.isConfigured() || !this.supportsChain(chainSlug)) return null;
    try {
      const now = Date.now();
      const from = now - days * 86400 * 1000;
      const url = `https://api.mobula.io/api/1/wallet/history?wallet=${address}&from=${from}&to=${now}`;
      const res = await fetch(url, { headers: { Authorization: this.apiKey!, accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as MobulaHistoryResponse;
      const points = json.data?.balance_history;
      if (!Array.isArray(points) || points.length === 0) return null;

      const byDate = new Map<string, number>();
      for (const p of points) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const ms = p[0]; // already milliseconds
        const value = Number(p[1]);
        if (!Number.isFinite(ms) || !Number.isFinite(value)) continue;
        byDate.set(new Date(ms).toISOString().slice(0, 10), value);
      }
      if (byDate.size === 0) return null;
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, value]) => ({ date, value }));
    } catch (e) {
      console.error('[wallet-data] mobula getValueHistory failed', (e as Error).message);
      return null;
    }
  }
}
