// On-demand historical USD price lookup (retrofit — starting-assets "as of date & time").
//
// We only store daily token_price_snapshot rows going forward from when the backend went live, so a
// cost-basis date before that has no stored history. Rather than rejecting the request, this resolves
// the token's USD price at (the closest available point to) the chosen instant from a PROVIDER CHAIN
// — same philosophy as the wallet value-history chain: try one provider, fall through to the next.
//
//   1. CoinGecko — markets→id map, then market_chart/range (+ daily /history). FREE/DEMO tier only
//      serves ~365 days, so older dates return nothing here and fall through.
//   2. Mobula — /market/history by symbol, multi-year coverage (the 2024/older gap CoinGecko can't
//      serve). Auth = raw key in the Authorization header (mirrors the Mobula wallet provider).
//
// EVERYTHING is fully guarded — any failure returns null so the chain advances; the caller only shows
// its "choose average or no cost" error when EVERY provider misses. NEVER throws. Add a provider by
// appending to PROVIDERS below.

import { config } from './config.js';
import { redis } from './redis.js';

// ── shared helpers ────────────────────────────────────────────────────────────

// Closest [tsMs, price] point to the target instant; null when no usable point.
function closestPrice(points: Array<[number, number]>, targetMs: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const pt of points) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const ts = pt[0];
    const price = pt[1];
    if (!Number.isFinite(ts) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    const d = Math.abs(ts - targetMs);
    if (d < bestDist) {
      bestDist = d;
      best = price;
    }
  }
  return best;
}

// ── Provider 1: CoinGecko ─────────────────────────────────────────────────────

const SYMBOL_MAP_KEY = 'cg:symbol-id-map:v1';
const SYMBOL_MAP_TTL_SEC = 60 * 60 * 12; // 12h — the top-cap catalog barely changes

function cgHeaders(): Record<string, string> {
  return config.COINGECKO_API_KEY
    ? { Accept: 'application/json', 'x-cg-demo-api-key': config.COINGECKO_API_KEY }
    : { Accept: 'application/json' };
}

async function cgGet(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${config.COINGECKO_BASE}${path}`, { headers: cgHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

// symbol(lowercase) → CoinGecko id (highest-market-cap on a ticker collision), cached in Redis.
async function getSymbolIdMap(): Promise<Record<string, string>> {
  try {
    const cached = await redis.get(SYMBOL_MAP_KEY);
    if (cached) return JSON.parse(cached) as Record<string, string>;
  } catch {
    /* rebuild below */
  }
  const map: Record<string, string> = {};
  const bestCap: Record<string, number> = {};
  for (let page = 1; page <= 3; page++) {
    const rows = (await cgGet(
      `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
    )) as Array<{ id: string; symbol: string; market_cap: number | null }> | null;
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      const s = (r.symbol ?? '').toLowerCase();
      if (!s) continue;
      const cap = r.market_cap ?? 0;
      if (bestCap[s] === undefined || cap > bestCap[s]!) {
        bestCap[s] = cap;
        map[s] = r.id;
      }
    }
  }
  if (Object.keys(map).length > 0) {
    try {
      await redis.set(SYMBOL_MAP_KEY, JSON.stringify(map), 'EX', SYMBOL_MAP_TTL_SEC);
    } catch {
      /* non-fatal */
    }
  }
  return map;
}

async function coinGeckoHistoricalPrice(symbol: string, asOf: Date): Promise<number | null> {
  const sym = (symbol ?? '').toLowerCase();
  if (!sym) return null;
  const id = (await getSymbolIdMap())[sym];
  if (!id) return null;

  const targetMs = asOf.getTime();
  const tsSec = Math.floor(targetMs / 1000);
  const range = (await cgGet(
    `/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${tsSec - 2 * 86400}&to=${tsSec + 2 * 86400}`,
  )) as { prices?: Array<[number, number]> } | null;
  const fromRange = closestPrice(range?.prices ?? [], targetMs);
  if (fromRange != null) return fromRange;

  // Daily fallback for that exact UTC day (still 365-day capped on free/demo).
  const dd = String(asOf.getUTCDate()).padStart(2, '0');
  const mm = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = asOf.getUTCFullYear();
  const hist = (await cgGet(
    `/coins/${encodeURIComponent(id)}/history?date=${dd}-${mm}-${yyyy}&localization=false`,
  )) as { market_data?: { current_price?: { usd?: number } } } | null;
  const hp = hist?.market_data?.current_price?.usd;
  return typeof hp === 'number' && Number.isFinite(hp) && hp > 0 ? hp : null;
}

// ── Provider 2: Mobula (multi-year, by symbol) ────────────────────────────────

async function mobulaHistoricalPrice(symbol: string, asOf: Date): Promise<number | null> {
  const key = config.MOBULA_API_KEY;
  const sym = (symbol ?? '').trim();
  if (!key || !sym) return null;

  const targetMs = asOf.getTime();
  let json: { data?: { price_history?: Array<[number, number]> } } | null = null;
  try {
    const res = await fetch(
      `https://api.mobula.io/api/1/market/history?asset=${encodeURIComponent(sym)}&from=${targetMs - 3 * 86400000}&to=${targetMs + 3 * 86400000}`,
      { headers: { Authorization: key, accept: 'application/json' } },
    );
    if (!res.ok) return null;
    json = (await res.json()) as { data?: { price_history?: Array<[number, number]> } };
  } catch {
    return null;
  }
  return closestPrice(json?.data?.price_history ?? [], targetMs);
}

// ── Provider 3: Alchemy Prices (multi-year, by symbol) ────────────────────────

async function alchemyHistoricalPrice(symbol: string, asOf: Date): Promise<number | null> {
  const key = config.ALCHEMY_API_KEY;
  const sym = (symbol ?? '').trim();
  if (!key || !sym) return null;

  const targetMs = asOf.getTime();
  let json: { data?: Array<{ value?: string | number; timestamp?: string | number }> } | null = null;
  try {
    const res = await fetch(`https://api.g.alchemy.com/prices/v1/${encodeURIComponent(key)}/tokens/historical`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        symbol: sym,
        startTime: Math.floor((targetMs - 2 * 86400000) / 1000),
        endTime: Math.floor((targetMs + 2 * 86400000) / 1000),
        interval: '1h',
      }),
    });
    if (!res.ok) return null;
    json = (await res.json()) as { data?: Array<{ value?: string | number; timestamp?: string | number }> };
  } catch {
    return null;
  }
  const rows = json?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const points: Array<[number, number]> = [];
  for (const r of rows) {
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number(r.timestamp) * 1000;
    const price = Number(r.value);
    if (Number.isFinite(ts) && Number.isFinite(price)) points.push([ts, price]);
  }
  return closestPrice(points, targetMs);
}

// ── Chain ─────────────────────────────────────────────────────────────────────
// Ordered by COVERAGE: multi-year providers first (so an old cost-basis date resolves), CoinGecko
// last (free/demo serves only ~365 days — the recent-date fast path). Each is guarded and falls
// through to the next on any miss. Add more by appending — note GoldRush/Covalent, Ankr and Moralis
// are address+chain based, so they need a chain recorded on Token before they can join this chain.

const PROVIDERS: Array<{
  name: string;
  fn: (symbol: string, asOf: Date) => Promise<number | null>;
}> = [
  { name: 'mobula', fn: mobulaHistoricalPrice },     // ~3 years, by symbol
  { name: 'alchemy', fn: alchemyHistoricalPrice },   // multi-year, by symbol
  { name: 'coingecko', fn: coinGeckoHistoricalPrice }, // ~365 days (free/demo) — recent-date fallback
];

// USD price for `symbol` at (the closest available point to) `asOf`, trying each provider in turn.
// Returns null only when EVERY provider misses.
export async function fetchHistoricalPriceUsd(symbol: string, asOf: Date): Promise<number | null> {
  if (!symbol || Number.isNaN(asOf.getTime())) return null;
  for (const p of PROVIDERS) {
    try {
      const price = await p.fn(symbol, asOf);
      if (price != null) return price;
    } catch {
      /* defensive — a provider must never break the chain */
    }
  }
  // Coverage gap — visible in logs so we can see which token/date no provider could serve.
  console.warn(`[historical-price] no provider returned a price for ${symbol} at ${asOf.toISOString()}`);
  return null;
}
