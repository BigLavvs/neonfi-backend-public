// Neonfi backend — Ankr read-side wallet provider (retrofit-47, fallback 3).
//
// Ankr Advanced API `ankr_getAccountBalance` (JSON-RPC, multichain endpoint). Balances
// are already human-readable and USD is provided (balanceUsd). onlyWhitelisted=true does
// the provider-side spam filtering. No Solana on this endpoint. Network/HTTP/parse/RPC-
// error failure → { status: 'error' }.

import type { ProviderResult, WalletDataProvider, WalletToken } from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Ankr blockchain id. No Solana here → supportsChain('solana') is false.
const ANKR_CHAIN: Record<string, string> = {
  eth: 'eth',
  polygon: 'polygon',
  bnb: 'bsc',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  avalanche: 'avalanche',
  fantom: 'fantom',
  linea: 'linea',
  gnosis: 'gnosis',
};

interface AnkrAsset {
  blockchain?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  tokenType?: string; // 'NATIVE' | 'ERC20' | ...
  contractAddress?: string;
  balance?: string;
  balanceUsd?: string;
  tokenPrice?: string;
}

export class AnkrWalletProvider implements WalletDataProvider {
  readonly name = 'ankr';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return chainSlug in ANKR_CHAIN;
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    const blockchain = ANKR_CHAIN[chainSlug];
    if (!blockchain) return { status: 'error' };
    try {
      const res = await fetch(`https://rpc.ankr.com/multichain/${this.apiKey!}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'ankr_getAccountBalance',
          params: { blockchain, walletAddress: address, onlyWhitelisted: true },
        }),
      });
      if (!res.ok) return { status: 'error' };
      const json = (await res.json()) as {
        result?: { assets?: AnkrAsset[] };
        error?: unknown;
      };
      if (json.error || !json.result) return { status: 'error' };
      const assets = Array.isArray(json.result.assets) ? json.result.assets : [];

      const kept: WalletToken[] = [];
      for (const a of assets) {
        const symbol = (a.tokenSymbol ?? '').toUpperCase();
        if (!symbol) continue;
        const isNative = (a.tokenType ?? '').toUpperCase() === 'NATIVE';
        const balance = Number(a.balance ?? '0');
        if (!Number.isFinite(balance) || balance <= 0) continue;
        const usdValue = a.balanceUsd != null ? Number(a.balanceUsd) : null;
        let usdPrice = a.tokenPrice != null ? Number(a.tokenPrice) : null;
        if (usdPrice == null && usdValue != null && balance > 0) usdPrice = usdValue / balance;
        if (usdValue == null && !isNative) continue; // unpriced non-native dust
        kept.push({
          symbol,
          name: a.tokenName ?? null,
          contractAddress: isNative ? null : (a.contractAddress ?? null),
          balance,
          decimals: a.tokenDecimals ?? null,
          usdPrice,
          usdValue,
          isNative,
        });
      }

      if (kept.length === 0) return { status: 'empty' };
      return { status: 'ok', summary: buildSummary(this.name, kept, NATIVE_SYMBOLS[chainSlug] ?? '') };
    } catch (e) {
      console.error('[wallet-data] ankr getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }
}
