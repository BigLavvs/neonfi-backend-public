// Neonfi backend — cross-exchange symbol / pair normalization (retrofit-16).
//
// Single source of truth mapping `Token.symbol` ↔ each exchange's product id,
// plus the USD-stable quote handling. All exchange-specific quirks live here so
// the WS clients (binance.ts / kraken.ts / coinbase.ts) stay dumb: they hand a
// raw exchange symbol in and get a catalog base + quote out, or `null` to skip.
//
// VERIFIED against official docs (2026-06, public market data, no keys):
//   - Binance spot WS: symbols are concatenated `BASE+QUOTE` with no delimiter,
//     e.g. `BTCUSDT`. Quote is inferred by suffix match (USDT/USDC/FDUSD).
//   - Kraken WS v2: pairs are slash-delimited and already normalized to the
//     standard base, e.g. `BTC/USD` (NOT the legacy `XBT`). We still map the
//     legacy quirks (XBT→BTC, XDG→DOGE) defensively in case a v1-style code leaks.

import { prisma } from './prisma.js';

// Binance USD-stable quotes in preference order. A base that trades against more
// than one of these in the same all-market batch resolves to the FIRST match so
// a thin USDC/FDUSD pair never overwrites the deep USDT price (Plan step 1).
export const PREFERRED_BINANCE_QUOTES = ['USDT', 'USDC', 'FDUSD'] as const;
export type PreferredBinanceQuote = (typeof PREFERRED_BINANCE_QUOTES)[number];

// Kraken legacy asset-code quirks → standard catalog symbol. WS v2 mostly emits
// the standard code already, so this is a defensive normalization only.
const KRAKEN_TO_STANDARD: Record<string, string> = {
  XBT: 'BTC',
  XDG: 'DOGE',
};

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

/**
 * Parse a Binance spot symbol (`BTCUSDT`) into its catalog base + quote, but
 * ONLY when the quote is one of the preferred USD-stables. Anything else
 * (BTC-quoted, EUR-quoted, etc.) returns null so the caller skips it.
 */
export function fromBinanceSymbol(symbol: string): { base: string; quote: PreferredBinanceQuote } | null {
  const s = symbol.toUpperCase();
  for (const quote of PREFERRED_BINANCE_QUOTES) {
    if (s.length > quote.length && s.endsWith(quote)) {
      return { base: s.slice(0, -quote.length), quote };
    }
  }
  return null;
}

/** Catalog symbol → Binance base asset. Binance uses the standard base. */
export function toBinanceBase(sym: string): string {
  return sym.toUpperCase();
}

// ---------------------------------------------------------------------------
// Kraken
// ---------------------------------------------------------------------------

/**
 * Parse a Kraken WS v2 pair name (`BTC/USD`) into catalog base + quote,
 * applying the legacy XBT→BTC / XDG→DOGE normalization defensively.
 */
export function fromKrakenName(name: string): { base: string; quote: string } | null {
  const parts = name.toUpperCase().split('/');
  if (parts.length !== 2) return null;
  const [rawBase, quote] = parts;
  if (!rawBase || !quote) return null;
  return { base: KRAKEN_TO_STANDARD[rawBase] ?? rawBase, quote };
}

/** Catalog symbol → Kraken WS v2 USD pair (`BTC` → `BTC/USD`). */
export function toKrakenPair(sym: string): string {
  return `${sym.toUpperCase()}/USD`;
}

// ---------------------------------------------------------------------------
// Gate.io (retrofit-36) — underscore-delimited `BASE_QUOTE`, USDT-quoted.
// ---------------------------------------------------------------------------

/** Parse a Gate.io pair (`BTC_USDT`) into catalog base + quote, or null. */
export function fromGatePair(pair: string): { base: string; quote: string } | null {
  const [base, quote] = pair.toUpperCase().split('_');
  return base && quote ? { base, quote } : null;
}

/** Catalog symbol → Gate.io USDT pair (`BTC` → `BTC_USDT`). */
export function toGatePair(sym: string): string {
  return `${sym.toUpperCase()}_USDT`;
}

// ---------------------------------------------------------------------------
// KuCoin (retrofit-36) — hyphen-delimited `BASE-QUOTE`, USDT-quoted.
// ---------------------------------------------------------------------------

/** Parse a KuCoin symbol (`BTC-USDT`) into catalog base + quote, or null. */
export function fromKucoinSymbol(symbol: string): { base: string; quote: string } | null {
  const [base, quote] = symbol.toUpperCase().split('-');
  return base && quote ? { base, quote } : null;
}

// ---------------------------------------------------------------------------
// Catalog working set (loaded once at boot from the Token table)
// ---------------------------------------------------------------------------

let catalogSymbols: Set<string> = new Set();
// Ordered by rank (nulls last) so Kraken/Coinbase coverage can take the top N.
let catalogByRank: string[] = [];

/**
 * Load the catalog working set from the Token table. Called once at boot
 * (index.ts) before connecting the feeds. Idempotent — safe to re-call.
 */
export async function loadCatalogSymbols(): Promise<Set<string>> {
  const tokens = await prisma.token.findMany({
    select: { symbol: true, rank: true },
    orderBy: [{ rank: 'asc' }],
  });
  // rank: 'asc' puts nulls last in Postgres, which is what we want.
  setCatalogSymbols(tokens.map((t) => t.symbol.toUpperCase()));
  return catalogSymbols;
}

/**
 * Replace the in-memory catalog working set. Used by loadCatalogSymbols() and
 * directly by tests so the client parse paths can be exercised without a DB.
 */
export function setCatalogSymbols(symbols: string[] | Set<string>): void {
  catalogByRank = [...symbols].map((s) => s.toUpperCase());
  catalogSymbols = new Set(catalogByRank);
}

export function isCatalogSymbol(sym: string): boolean {
  return catalogSymbols.has(sym.toUpperCase());
}

export function getCatalogSymbols(): Set<string> {
  return catalogSymbols;
}

/**
 * Kraken coverage: top-N catalog symbols by rank as `SYM/USD` pairs. Kraken has
 * no all-market stream and caps per-connection subscriptions, so we bound the
 * list (default 300). Pairs Kraken does not list simply yield a per-pair
 * subscribe error and are ignored — they never break the connection.
 */
export function getKrakenCoverage(limit = 300): string[] {
  return catalogByRank.slice(0, limit).map(toKrakenPair);
}
