// Neonfi backend — Moralis read-side wallet provider (retrofit-47, PRIMARY).
//
// Reads the wallet via the Moralis Web3 Data API (NOT the Streams API — that stays
// untouched). EVM via the deep-index `/wallets/{address}/tokens` endpoint keyed by the
// chain hex (chains.constants moralisId); Solana via the solana-gateway portfolio
// endpoint. Network/HTTP/parse failure → { status: 'error' } (never throws out).

import { CHAINS } from '../../chains/chains.constants.js';
import type { ProviderResult, WalletDataProvider, WalletToken } from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Moralis chain identifier (hex for EVM, 'solana' for Solana).
const CHAIN_ID = new Map(CHAINS.map((c) => [c.slug, c.moralisId]));

interface MoralisEvmToken {
  symbol?: string;
  name?: string;
  token_address?: string | null;
  decimals?: number | string | null;
  balance_formatted?: string;
  usd_value?: number | string | null;
  usd_price?: number | string | null;
  native_token?: boolean;
  possible_spam?: boolean;
}

interface MoralisSolanaPortfolio {
  nativeBalance?: { solana?: string };
  tokens?: Array<{
    symbol?: string;
    name?: string;
    associatedTokenAddress?: string;
    amount?: string;
    decimals?: number;
  }>;
}

export class MoralisWalletProvider implements WalletDataProvider {
  readonly name = 'moralis';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly deepIndexBase: string,
    private readonly solanaBase: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    // Moralis covers every catalog chain — EVM via hex, Solana via the gateway.
    return CHAIN_ID.has(chainSlug);
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    try {
      return chainSlug === 'solana'
        ? await this.getSolana(address)
        : await this.getEvm(address, chainSlug);
    } catch (e) {
      console.error('[wallet-data] moralis getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey!, accept: 'application/json' };
  }

  private async getEvm(address: string, chainSlug: string): Promise<ProviderResult> {
    const hex = CHAIN_ID.get(chainSlug);
    if (!hex) return { status: 'error' };
    const url = `${this.deepIndexBase}/wallets/${address}/tokens?chain=${hex}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return { status: 'error' };
    const json = (await res.json()) as { result?: MoralisEvmToken[] };
    const items = Array.isArray(json.result) ? json.result : [];

    const kept: WalletToken[] = [];
    for (const it of items) {
      if (it.possible_spam === true) continue; // provider-flagged spam
      const symbol = (it.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const isNative = it.native_token === true;
      const balance = Number(it.balance_formatted ?? '0');
      if (!Number.isFinite(balance) || balance <= 0) continue;
      const usdValue = it.usd_value != null ? Number(it.usd_value) : null;
      const usdPrice = it.usd_price != null ? Number(it.usd_price) : null;
      // Unpriced non-native token → almost always junk/dust → drop. Native always kept.
      if (usdValue == null && !isNative) continue;
      kept.push({
        symbol,
        name: it.name ?? null,
        contractAddress: isNative ? null : (it.token_address ?? null),
        balance,
        decimals: it.decimals != null ? Number(it.decimals) : null,
        usdPrice,
        usdValue,
        isNative,
      });
    }

    if (kept.length === 0) return { status: 'empty' };
    return { status: 'ok', summary: buildSummary(this.name, kept, NATIVE_SYMBOLS[chainSlug] ?? '') };
  }

  private async getSolana(address: string): Promise<ProviderResult> {
    const url = `${this.solanaBase}/account/mainnet/${address}/portfolio`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return { status: 'error' };
    const json = (await res.json()) as MoralisSolanaPortfolio;

    const kept: WalletToken[] = [];
    const solBalance = Number(json.nativeBalance?.solana ?? '0');
    if (Number.isFinite(solBalance) && solBalance > 0) {
      kept.push({
        symbol: 'SOL',
        name: 'Solana',
        contractAddress: null,
        balance: solBalance,
        decimals: 9,
        usdPrice: null,
        usdValue: null,
        isNative: true,
      });
    }
    // The Solana portfolio endpoint returns NO USD, so the "unpriced non-native = dust"
    // rule can't apply here (it would nuke every real SPL holding). Keep SPL tokens with
    // a positive balance; totalUsd stays null but balances + count are still accurate.
    for (const t of json.tokens ?? []) {
      const symbol = (t.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const balance = Number(t.amount ?? '0');
      if (!Number.isFinite(balance) || balance <= 0) continue;
      kept.push({
        symbol,
        name: t.name ?? null,
        contractAddress: t.associatedTokenAddress ?? null,
        balance,
        decimals: t.decimals ?? null,
        usdPrice: null,
        usdValue: null,
        isNative: false,
      });
    }

    if (kept.length === 0) return { status: 'empty' };
    return { status: 'ok', summary: buildSummary(this.name, kept, 'SOL') };
  }
}
