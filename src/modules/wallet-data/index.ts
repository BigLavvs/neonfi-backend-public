// Neonfi backend — wallet-data orchestrator (retrofit-47).
//
// Tries the read-side providers in priority order (Moralis → Covalent/GoldRush → Alchemy
// → Ankr), each gated on its own optional API key. The first provider that returns an
// `ok` summary wins. The three frontend outcomes:
//   - 'found'   — a provider returned holdings → summary present.
//   - 'empty'   — well-formed address but no provider reports holdings (new/empty wallet,
//                 or nobody could verify). Frontend offers "add it anyway?".
//   - 'invalid' — address fails format validation for the chain.

import { config } from '../../lib/config.js';
import { validateWalletAddress } from '../portfolios/wallet-validator.js';
import type { WalletDataProvider, WalletSummary } from './types.js';
import { MoralisWalletProvider } from './providers/moralis.js';
import { GoldRushWalletProvider } from './providers/goldrush.js';
import { AlchemyWalletProvider } from './providers/alchemy.js';
import { AnkrWalletProvider } from './providers/ankr.js';

export type PreviewStatus = 'found' | 'empty' | 'invalid';
export interface WalletPreview {
  status: PreviewStatus;
  summary?: WalletSummary;
}

// Priority order. A provider with no key reports isConfigured() === false and is skipped.
export const PROVIDERS: WalletDataProvider[] = [
  new MoralisWalletProvider(
    config.MORALIS_API_KEY,
    config.MORALIS_DEEP_INDEX_BASE,
    config.MORALIS_SOLANA_BASE,
  ),
  new GoldRushWalletProvider(config.GOLDRUSH_API_KEY),
  new AlchemyWalletProvider(config.ALCHEMY_API_KEY),
  new AnkrWalletProvider(config.ANKR_API_KEY),
];

export async function previewWallet(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<WalletPreview> {
  const v = validateWalletAddress(address, chain);
  if (!v.valid) return { status: 'invalid' };
  const addr = v.normalized!;
  for (const p of providers) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug)) continue;
    const r = await p.getSummary(addr, chain.slug);
    if (r.status === 'ok' && r.summary) return { status: 'found', summary: r.summary };
    // 'empty'/'error' → fall through to the next provider.
  }
  // Well-formed address but no holdings anywhere (or nobody could verify) → 'empty'.
  return { status: 'empty' };
}

// Used by the initial sync — returns the winning summary (or null).
export async function fetchWalletSummary(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<WalletSummary | null> {
  const p = await previewWallet(address, chain, providers);
  return p.summary ?? null;
}
