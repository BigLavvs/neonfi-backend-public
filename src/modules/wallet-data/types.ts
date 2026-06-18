// Neonfi backend — read-side wallet-data provider contracts (retrofit-47).
//
// A small, provider-agnostic shape that every data source (Moralis, Covalent/GoldRush,
// Alchemy, Ankr) normalizes its response into. The orchestrator (index.ts) tries the
// providers in priority order and the first `ok` summary wins; the initial-sync path
// (sync.ts) reuses the same summary to seed holdings.

export interface WalletToken {
  symbol: string;
  name: string | null;            // token name (for auto-listing non-catalog tokens on sync)
  contractAddress: string | null; // null for native
  balance: number;                // human-readable (formatted) units
  decimals: number | null;
  usdPrice: number | null;        // per-unit USD price from the provider (for valuation/auto-list)
  usdValue: number | null;        // null when a provider can't price it
  isNative: boolean;
}

export interface WalletSummary {
  nativeSymbol: string;
  nativeBalance: number;
  totalUsd: number | null;        // null if NO token had a USD value
  tokenCount: number;             // distinct tokens with balance > 0 (incl. native if > 0)
  tokens: WalletToken[];          // all tokens with balance > 0, sorted by usdValue desc (nulls last)
  provider: string;               // which provider produced this
}

// Per-provider outcome. 'error' = provider failed/unsupported/no-key → try the next one.
export type ProviderStatus = 'ok' | 'empty' | 'error';
export interface ProviderResult {
  status: ProviderStatus;
  summary?: WalletSummary; // present when status === 'ok'
}

export interface WalletDataProvider {
  name: string;
  isConfigured(): boolean;            // key present?
  supportsChain(chainSlug: string): boolean;
  getSummary(address: string, chainSlug: string): Promise<ProviderResult>;
}
