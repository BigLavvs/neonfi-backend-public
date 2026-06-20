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
import { redis } from '../../lib/redis.js';
import { validateWalletAddress } from '../portfolios/wallet-validator.js';
import type {
  TransferPage,
  WalletDataProvider,
  WalletNftHolding,
  WalletPnl,
  WalletSummary,
} from './types.js';
import { MoralisWalletProvider } from './providers/moralis.js';
import { ZerionWalletProvider } from './providers/zerion.js';
import { MobulaWalletProvider } from './providers/mobula.js';
import { GoldRushWalletProvider } from './providers/goldrush.js';
import { AlchemyWalletProvider } from './providers/alchemy.js';
import { AnkrWalletProvider } from './providers/ankr.js';

// retrofit-60 Part E: 'found_no_history' = balances exist but NO provider can supply value history
// (brand-new wallet, unsupported chain, or none indexed it). The frontend handles it like the
// empty-wallet "add anyway?" prompt — "we found it, but the chart will build from today."
export type PreviewStatus = 'found' | 'found_no_history' | 'empty' | 'invalid';
export interface WalletPreview {
  status: PreviewStatus;
  summary?: WalletSummary;
}

// Priority order. A provider with no key reports isConfigured() === false and is skipped.
// retrofit-60: Zerion + Mobula are value-history-only (their getSummary returns 'error', so the
// summary chain skips straight past them to GoldRush/Alchemy/Ankr). They sit ahead of GoldRush so
// the getValueHistory loop prefers their ONE-CALL multi-year curve over GoldRush's ~1yr.
export const PROVIDERS: WalletDataProvider[] = [
  new MoralisWalletProvider(
    config.MORALIS_API_KEY,
    config.MORALIS_DEEP_INDEX_BASE,
    config.MORALIS_SOLANA_BASE,
  ),
  new ZerionWalletProvider(config.ZERION_API_KEY),
  new MobulaWalletProvider(config.MOBULA_API_KEY),
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
    if (r.status === 'ok' && r.summary) {
      // retrofit-60 Part E: a found wallet gets a LIGHT history check — one-call providers only
      // (Zerion → Mobula → GoldRush via fetchValueHistory; Moralis sampling is too heavy for a
      // preview and is deferred to the full sync). At most one extra call. No series → warn the
      // user up front with 'found_no_history'.
      const hasHistory = await hasConnectedValueHistory(addr, chain, providers);
      return { status: hasHistory ? 'found' : 'found_no_history', summary: r.summary };
    }
    // 'empty'/'error' → fall through to the next provider.
  }
  // Well-formed address but no holdings anywhere (or nobody could verify) → 'empty'.
  return { status: 'empty' };
}

// retrofit-60 Part E: does ANY one-call provider have value history for this wallet? Reuses the
// getValueHistory chain (Zerion/Mobula/GoldRush) — Moralis has no getValueHistory method, so the
// heavy to_block sampler never runs here. A modest window is enough to detect "any history exists".
async function hasConnectedValueHistory(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[],
): Promise<boolean> {
  const vh = await fetchValueHistory(address, chain, 365, providers);
  return Array.isArray(vh) && vh.length > 0;
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

// retrofit-84 (H13): cross-provider CHAIN-GLOBAL spam-contract DB. UNLIKE the first-non-null
// capabilities above, this UNIONS every provider that can supply a chain-global spam-contract set
// (Alchemy getSpamContracts) so the strongest combined signal is used regardless of which provider
// supplied the NFT holdings. Returns a set of LOWERCASED contract addresses (empty when no provider
// supports it — never null, so the caller treats "no signal" uniformly).
// NOTE (retrofit-86): on our plan Alchemy's NFT API is 403 plan-gated, so this set is empty today;
// the working cross-provider signal is the PER-WALLET fetchWalletSpamContracts (GoldRush) below.
// Cached per chain (Redis, SPAM_CONTRACTS_TTL_S) so a sync loop / webhook doesn't refetch it.
const SPAM_CONTRACTS_TTL_S = 6 * 60 * 60; // 6h — spam DBs change slowly; resync isn't frequent.

// cacheKey null = don't cache (the test path injects custom providers and must stay deterministic;
// caching is a production concern keyed on the default PROVIDERS).
async function unionSpamContracts(
  cacheKey: string | null,
  providers: WalletDataProvider[],
  fetchOne: (p: WalletDataProvider) => Promise<Set<string> | null>,
  supports: (p: WalletDataProvider) => boolean,
): Promise<Set<string>> {
  if (cacheKey) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return new Set(JSON.parse(cached) as string[]);
      } catch {
        /* malformed — refetch below */
      }
    }
  }
  const out = new Set<string>();
  for (const p of providers) {
    if (!p.isConfigured() || !supports(p)) continue;
    try {
      const set = await fetchOne(p);
      if (set) for (const addr of set) out.add(addr);
    } catch (e) {
      // A spam-DB hiccup must never break the NFT sync — fall through with whatever we have.
      console.error('[wallet-data] spam-contract provider failed', p.name, (e as Error).message);
    }
  }
  if (cacheKey) {
    await redis
      .set(cacheKey, JSON.stringify([...out]), 'EX', SPAM_CONTRACTS_TTL_S)
      .catch((e: Error) => console.error('[wallet-data] spam-contract cache set failed', e.message));
  }
  return out;
}

export async function fetchSpamContracts(
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<Set<string>> {
  return unionSpamContracts(
    providers === PROVIDERS ? `spam_contracts:${chain.slug}` : null,
    providers,
    (p) => p.getSpamContracts!(chain.slug),
    (p) => p.supportsChain(chain.slug) && Boolean(p.getSpamContracts),
  );
}

// retrofit-86 (H13.1): PER-WALLET spam-contract set, unioned across providers that classify spam on
// the wallet's holdings rather than chain-globally (GoldRush balances_nft.is_spam). This is the
// signal that actually contributes on our plan (Alchemy's chain-global list is 403-gated). Cached
// per wallet+chain so a resync / a burst of webhook events reuses it. Empty set = no signal (never
// null). The caller unions this with fetchSpamContracts() for the full provider spam-contract view.
export async function fetchWalletSpamContracts(
  address: string,
  chain: { slug: string },
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<Set<string>> {
  return unionSpamContracts(
    providers === PROVIDERS ? `wallet_spam_contracts:${chain.slug}:${address.toLowerCase()}` : null,
    providers,
    (p) => p.getWalletSpamContracts!(address, chain.slug),
    (p) => p.supportsChain(chain.slug) && Boolean(p.getWalletSpamContracts),
  );
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

// retrofit-79 (§1): per-capability provider priority for wallet PnL — GoldRush FIRST (it
// returns cost basis + realized + unrealized across its chains), Moralis the realized-only
// fallback. This OVERRIDES the global Moralis-first PROVIDERS order; any provider not listed
// here sorts last (defensive — only GoldRush/Moralis implement getWalletPnl today).
const PNL_PROVIDER_ORDER: Record<string, number> = { goldrush: 0, moralis: 1 };

// Cache the normalized PnL per wallet+chain — it only changes on new trades, and the GoldRush
// query is a slow server-side computation, so we don't want to recompute it on every read.
const PNL_CACHE_TTL_S = 6 * 60 * 60; // 6h
const pnlCacheKey = (address: string, chainSlug: string): string =>
  `wallet_pnl:${chainSlug}:${address.toLowerCase()}`;

// retrofit-79 (§1): the wallet's per-token PnL / cost basis. Tries providers in the PnL-specific
// priority (GoldRush → Moralis); the first USABLE response (non-null with ≥1 token) wins, and an
// error / empty / unsupported-chain falls through — never throws, so a PnL miss can't fail a sync
// (the caller degrades the connected portfolio to "—"). Cached for 6h unless `bypassCache` (resync
// forces a fresh fetch). Returns null when no provider can supply it.
export async function fetchWalletPnl(
  address: string,
  chain: { slug: string },
  opts: { bypassCache?: boolean } = {},
  providers: WalletDataProvider[] = PROVIDERS,
): Promise<WalletPnl | null> {
  const key = pnlCacheKey(address, chain.slug);
  const readCache = async (): Promise<WalletPnl | null> => {
    const cached = await redis.get(key).catch(() => null);
    if (!cached) return null;
    try {
      return JSON.parse(cached) as WalletPnl;
    } catch {
      return null; // malformed payload
    }
  };

  if (!opts.bypassCache) {
    const cached = await readCache();
    if (cached) return cached;
  }

  const ordered = providers
    .filter((p) => p.getWalletPnl && p.isConfigured() && p.supportsChain(chain.slug))
    .sort((a, b) => (PNL_PROVIDER_ORDER[a.name] ?? 99) - (PNL_PROVIDER_ORDER[b.name] ?? 99));
  for (const p of ordered) {
    const pnl = await p.getWalletPnl!(address, chain.slug);
    if (pnl && pnl.tokens.length > 0) {
      await redis
        .set(key, JSON.stringify(pnl), 'EX', PNL_CACHE_TTL_S)
        .catch((e: Error) => console.error('[wallet-data] pnl cache set failed', e.message));
      return pnl;
    }
    // null / empty → fall through to the next provider.
  }

  // retrofit-79: a forced refresh (resync) that comes back empty (the Beta uPnL WS is slow and
  // intermittently times out) falls back to the last cached PnL rather than regressing to null —
  // so a flaky fetch never WIPES cost basis a prior sync established.
  if (opts.bypassCache) {
    const cached = await readCache();
    if (cached) return cached;
  }
  return null;
}
