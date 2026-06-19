// Neonfi backend — Covalent / GoldRush read-side wallet provider (retrofit-47, fallback 1).
//
// balances_v2 with no-spam=true (provider-side spam filtering) + quote-currency=USD.
// Raw balances are integer strings scaled by contract_decimals. Network/HTTP/parse
// failure → { status: 'error' }.

import type { ProviderResult, WalletDataProvider, WalletToken } from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Covalent chain name. polygon-zkevm intentionally omitted (uncertain mapping).
const COV_CHAIN: Record<string, string> = {
  eth: 'eth-mainnet',
  polygon: 'matic-mainnet',
  bnb: 'bsc-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  base: 'base-mainnet',
  avalanche: 'avalanche-mainnet',
  fantom: 'fantom-mainnet',
  linea: 'linea-mainnet',
  zksync: 'zksync-mainnet',
  gnosis: 'gnosis-mainnet',
  cronos: 'cronos-mainnet',
  mantle: 'mantle-mainnet',
  solana: 'solana-mainnet',
};

interface CovalentItem {
  contract_ticker_symbol?: string | null;
  contract_name?: string | null;
  contract_decimals?: number | null;
  contract_address?: string | null;
  balance?: string | null;
  quote?: number | null;
  quote_rate?: number | null;
  native_token?: boolean;
}

export class GoldRushWalletProvider implements WalletDataProvider {
  readonly name = 'goldrush';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return chainSlug in COV_CHAIN;
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return { status: 'error' };
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/balances_v2/` +
        `?quote-currency=USD&no-spam=true`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return { status: 'error' };
      const json = (await res.json()) as { data?: { items?: CovalentItem[] } };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];

      const kept: WalletToken[] = [];
      for (const it of items) {
        const symbol = (it.contract_ticker_symbol ?? '').toUpperCase();
        if (!symbol) continue;
        const isNative = it.native_token === true;
        const decimals = it.contract_decimals ?? null;
        const balance = humanBalance(it.balance, decimals);
        if (!Number.isFinite(balance) || balance <= 0) continue;
        const usdValue = it.quote != null ? Number(it.quote) : null;
        const usdPrice = it.quote_rate != null ? Number(it.quote_rate) : null;
        if (usdValue == null && !isNative) continue; // unpriced non-native dust
        kept.push({
          symbol,
          name: it.contract_name ?? null,
          contractAddress: isNative ? null : (it.contract_address ?? null),
          balance,
          decimals,
          usdPrice,
          usdValue,
          isNative,
        });
      }

      if (kept.length === 0) return { status: 'empty' };
      return { status: 'ok', summary: buildSummary(this.name, kept, NATIVE_SYMBOLS[chainSlug] ?? '') };
    } catch (e) {
      console.error('[wallet-data] goldrush getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }

  // retrofit-56: the wallet's REAL on-chain tx total. Probe-confirmed shape:
  // transactions_summary → data.items[0].total_count. null on non-ok/parse failure
  // (callers fall back to the imported DB row count).
  async getTransactionCount(address: string, chainSlug: string): Promise<number | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/transactions_summary/` +
        `?quote-currency=USD`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { items?: Array<{ total_count?: number | null }> } };
      const total = json.data?.items?.[0]?.total_count;
      return typeof total === 'number' && Number.isFinite(total) ? total : null;
    } catch (e) {
      console.error('[wallet-data] goldrush getTransactionCount failed', (e as Error).message);
      return null;
    }
  }

  // retrofit-56: daily portfolio USD value for the last `days` days, for BalanceSnapshot
  // backfill. Probe-confirmed shape: portfolio_v2 → data.items[] is PER-TOKEN, each with a
  // daily holdings[] (days+1 entries, newest-first), holdings[].timestamp (ISO) +
  // holdings[].close.quote (USD). Sum close.quote across all tokens per date → one series,
  // ASC by date. null on non-ok/parse/empty (caller skips the backfill).
  async getValueHistory(
    address: string,
    chainSlug: string,
    days: number,
  ): Promise<Array<{ date: string; value: number }> | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/portfolio_v2/` +
        `?quote-currency=USD&days=${days}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { items?: Array<{ holdings?: Array<CovalentHolding> }> };
      };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];
      const byDate = new Map<string, number>();
      for (const token of items) {
        for (const h of token.holdings ?? []) {
          if (!h.timestamp) continue;
          const date = h.timestamp.slice(0, 10); // 'YYYY-MM-DD'
          const q = h.close?.quote;
          if (q == null || !Number.isFinite(Number(q))) continue;
          byDate.set(date, (byDate.get(date) ?? 0) + Number(q));
        }
      }
      if (byDate.size === 0) return null;
      // 'YYYY-MM-DD' sorts lexicographically == chronologically.
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, value]) => ({ date, value }));
    } catch (e) {
      console.error('[wallet-data] goldrush getValueHistory failed', (e as Error).message);
      return null;
    }
  }
}

// portfolio_v2 daily holding entry (probe-confirmed: open/high/low/close each carry a USD
// `quote`; we read the day's close).
interface CovalentHolding {
  timestamp?: string | null;
  close?: { quote?: number | null } | null;
}

// Covalent returns the raw integer balance as a string; divide by 10^decimals.
function humanBalance(raw: string | null | undefined, decimals: number | null): number {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return decimals && decimals > 0 ? n / 10 ** decimals : n;
}
