// Neonfi backend — Alchemy read-side wallet provider (retrofit-47, fallback 2).
//
// Uses the Alchemy Portfolio Data API `assets/tokens/by-address`, which returns balances
// + metadata (+ USD price on supported tiers) in one call. tokenBalance is a hex string
// scaled by decimals; tokenAddress null = the chain's native gas token. USD pricing is
// OPTIONAL — when a token has no price the value stays null (summary still shows balances
// + count). The JSON-RPC fallback in the spec is not wired (Data API is sufficient here).
// Network/HTTP/parse failure → { status: 'error' }.

import type { ProviderResult, WalletDataProvider, WalletToken } from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Alchemy network identifier.
const ALCHEMY_NETWORK: Record<string, string> = {
  eth: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  base: 'base-mainnet',
  avalanche: 'avax-mainnet',
  bnb: 'bnb-mainnet',
  fantom: 'fantom-mainnet',
  linea: 'linea-mainnet',
  gnosis: 'gnosis-mainnet',
  solana: 'solana-mainnet',
};

interface AlchemyToken {
  network?: string;
  tokenAddress?: string | null; // null for native
  tokenBalance?: string | null; // hex
  tokenMetadata?: { symbol?: string | null; decimals?: number | null; name?: string | null } | null;
  tokenPrices?: Array<{ currency?: string; value?: string | number | null }> | null;
}

export class AlchemyWalletProvider implements WalletDataProvider {
  readonly name = 'alchemy';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return chainSlug in ALCHEMY_NETWORK;
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    const network = ALCHEMY_NETWORK[chainSlug];
    if (!network) return { status: 'error' };
    try {
      const url = `https://api.g.alchemy.com/data/v1/${this.apiKey!}/assets/tokens/by-address`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ addresses: [{ address, networks: [network] }] }),
      });
      if (!res.ok) return { status: 'error' };
      const json = (await res.json()) as { data?: { tokens?: AlchemyToken[] } };
      const items = Array.isArray(json.data?.tokens) ? json.data!.tokens! : [];

      const kept: WalletToken[] = [];
      for (const it of items) {
        const isNative = it.tokenAddress == null;
        const meta = it.tokenMetadata ?? {};
        const decimals = meta.decimals ?? (isNative ? 18 : null);
        const balance = hexToHuman(it.tokenBalance, decimals);
        if (!Number.isFinite(balance) || balance <= 0) continue;
        const symbol = (meta.symbol ?? (isNative ? NATIVE_SYMBOLS[chainSlug] : '') ?? '').toUpperCase();
        if (!symbol) continue;
        const usdPrice = extractUsdPrice(it.tokenPrices);
        const usdValue = usdPrice != null ? usdPrice * balance : null;
        if (usdValue == null && !isNative) continue; // unpriced non-native dust
        kept.push({
          symbol,
          name: meta.name ?? null,
          contractAddress: isNative ? null : (it.tokenAddress ?? null),
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
      console.error('[wallet-data] alchemy getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }
}

function hexToHuman(hex: string | null | undefined, decimals: number | null): number {
  if (!hex) return 0;
  let raw: number;
  try {
    raw = Number(BigInt(hex));
  } catch {
    raw = Number(hex);
  }
  if (!Number.isFinite(raw)) return 0;
  return decimals && decimals > 0 ? raw / 10 ** decimals : raw;
}

function extractUsdPrice(
  prices: Array<{ currency?: string; value?: string | number | null }> | null | undefined,
): number | null {
  if (!Array.isArray(prices)) return null;
  const usd = prices.find((p) => (p.currency ?? 'usd').toLowerCase() === 'usd') ?? prices[0];
  if (!usd || usd.value == null) return null;
  const v = Number(usd.value);
  return Number.isFinite(v) ? v : null;
}
