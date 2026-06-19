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
import type {
  TransferPage,
  WalletDataProvider,
  WalletNftHolding,
  WalletSummary,
} from './types.js';
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

// retrofit-49: real transfer-history import. Returns the first configured provider's
// non-null history page (Moralis first — primary + richest); a provider that doesn't
// implement getTransferHistory, isn't configured, doesn't support the chain, or returns
// null is skipped. null overall = no provider can supply history (e.g. Solana) → the sync
// degrades to opening-lot-only. The address is assumed already validated/normalized (the
// connected portfolio stored its normalized walletAddress at create time).
export async function fetchTransferPage(
  address: string,
  chain: { slug: string },
  opts: { cursor?: string | null; limit?: number },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<TransferPage | null> {
  for (const p of providers) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug) || !p.getTransferHistory) continue;
    const page = await p.getTransferHistory(address, chain.slug, opts);
    if (page) return page;
  }
  return null;
}

// retrofit-49: current NFT holdings (predating the transfer window). Same first-non-null
// fall-through as fetchTransferPage.
export async function fetchNftHoldings(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<WalletNftHolding[] | null> {
  for (const p of providers) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug) || !p.getNftHoldings) continue;
    const holdings = await p.getNftHoldings(address, chain.slug);
    if (holdings) return holdings;
  }
  return null;
}

// retrofit-56: the wallet's REAL on-chain tx total (GoldRush implements it; Moralis history
// rarely returns a reliable total). First non-null wins; null = no provider can supply it →
// the caller leaves externalTxCount unset and the overview falls back to the DB row count.
export async function fetchTransactionCount(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<number | null> {
  for (const p of providers) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug) || !p.getTransactionCount) continue;
    const n = await p.getTransactionCount(address, chain.slug);
    if (n != null) return n;
  }
  return null;
}

// retrofit-56: daily portfolio USD value (ASC by date) for BalanceSnapshot backfill. First
// non-null wins; null = no provider can supply it → the caller skips the backfill.
export async function fetchValueHistory(
  address: string,
  chain: { slug: string },
  days: number,
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<Array<{ date: string; value: number }> | null> {
  for (const p of providers) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug) || !p.getValueHistory) continue;
    const vh = await p.getValueHistory(address, chain.slug, days);
    if (vh) return vh;
  }
  return null;
}
