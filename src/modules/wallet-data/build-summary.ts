// Neonfi backend — shared WalletSummary finalizer (retrofit-47).
//
// Every provider does its own spam/dust filtering (per §2b) and hands the KEPT tokens
// (balance > 0) to buildSummary, which applies the cross-provider presentation rules:
// sort by usdValue desc (nulls last), cap at ~100, derive totals + native entry. Keeping
// this in one place means the four providers stay thin parsers.

import type { WalletSummary, WalletToken } from './types.js';

// Native (gas) token symbol per chain slug. Used as the nativeSymbol fallback when the
// provider returns no native entry (native balance 0 → dropped from tokens[]), so the
// summary still names the chain's gas token. Mirrors chains.constants.ts slugs.
export const NATIVE_SYMBOLS: Record<string, string> = {
  eth: 'ETH',
  polygon: 'MATIC',
  bnb: 'BNB',
  arbitrum: 'ETH',
  optimism: 'ETH',
  base: 'ETH',
  avalanche: 'AVAX',
  solana: 'SOL',
  fantom: 'FTM',
  linea: 'ETH',
  zksync: 'ETH',
  'polygon-zkevm': 'ETH',
  cronos: 'CRO',
  gnosis: 'XDAI',
  mantle: 'MNT',
};

const MAX_TOKENS = 100;

// usdValue desc, nulls last.
function byUsdValueDesc(a: WalletToken, b: WalletToken): number {
  if (a.usdValue == null && b.usdValue == null) return 0;
  if (a.usdValue == null) return 1;
  if (b.usdValue == null) return -1;
  return b.usdValue - a.usdValue;
}

export function buildSummary(
  providerName: string,
  keptTokens: WalletToken[],
  fallbackNativeSymbol: string,
): WalletSummary {
  const tokens = [...keptTokens].sort(byUsdValueDesc).slice(0, MAX_TOKENS);

  const native = tokens.find((t) => t.isNative);
  const priced = tokens.filter((t) => t.usdValue != null);
  const totalUsd = priced.length > 0 ? priced.reduce((sum, t) => sum + (t.usdValue ?? 0), 0) : null;

  return {
    nativeSymbol: native?.symbol ?? fallbackNativeSymbol,
    nativeBalance: native?.balance ?? 0,
    totalUsd,
    tokenCount: tokens.length,
    tokens,
    provider: providerName,
  };
}
