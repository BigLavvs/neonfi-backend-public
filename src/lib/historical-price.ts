// On-demand historical USD price lookup (retrofit — starting-assets "as of date & time").
//
// We only store daily token_price_snapshot rows going forward from when the backend went live,
// so a user picking a cost-basis date BEFORE that has no stored history. Rather than rejecting the
// request, this fetches the token's USD price at (the closest available point to) the requested
// timestamp from CoinGecko — the same source the snapshot backfill uses.
//
// Mirrors backfill-snapshots.ts's CoinGecko client: demo key (when set) rides the same public base
// via the `x-cg-demo-api-key` header. EVERYTHING here is fully guarded — any failure returns null so
// the caller falls back to its existing "choose average or no cost" error only when the price is
// genuinely unavailable. NEVER throws.

import { config } from './config.js';
import { redis } from './redis.js';

// symbol(lowercase) → CoinGecko id, cached so we resolve the catalog at most once per TTL.
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

// Build (or read from cache) the symbol → CoinGecko-id map. A ticker collision resolves to the
// HIGHEST-market-cap coin (markets are market_cap_desc but we pick by max explicitly), matching
// the backfill's buildSymbolIdMap. Returns {} when CoinGecko is unreachable.
async function getSymbolIdMap(): Promise<Record<string, string>> {
  try {
    const cached = await redis.get(SYMBOL_MAP_KEY);
    if (cached) return JSON.parse(cached) as Record<string, string>;
  } catch {
    /* cache miss / parse error → rebuild below */
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
      /* non-fatal — just means we rebuild next time */
    }
  }
  return map;
}

// USD price for `symbol` at the closest available point to `asOf`, or null if unavailable.
// Granularity is CoinGecko's: ~hourly within the last 90 days, daily beyond — the best the
// free/demo tier offers for a historical instant.
export async function fetchHistoricalPriceUsd(symbol: string, asOf: Date): Promise<number | null> {
  const sym = (symbol ?? '').toLowerCase();
  if (!sym || Number.isNaN(asOf.getTime())) return null;

  const id = (await getSymbolIdMap())[sym];
  if (!id) return null;

  const targetMs = asOf.getTime();
  const tsSec = Math.floor(targetMs / 1000);
  // ±2-day window so the range query returns usable points around the instant.
  const range = (await cgGet(
    `/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${tsSec - 2 * 86400}&to=${tsSec + 2 * 86400}`,
  )) as { prices?: Array<[number, number]> } | null;

  const points = range?.prices ?? [];
  if (points.length > 0) {
    let best = points[0]!;
    let bestDist = Math.abs(best[0] - targetMs);
    for (const pt of points) {
      const d = Math.abs(pt[0] - targetMs);
      if (d < bestDist) {
        bestDist = d;
        best = pt;
      }
    }
    const p = best[1];
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) return p;
  }

  // Fallback: the daily snapshot for that exact UTC day — works for any past date.
  const dd = String(asOf.getUTCDate()).padStart(2, '0');
  const mm = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = asOf.getUTCFullYear();
  const hist = (await cgGet(
    `/coins/${encodeURIComponent(id)}/history?date=${dd}-${mm}-${yyyy}&localization=false`,
  )) as { market_data?: { current_price?: { usd?: number } } } | null;
  const hp = hist?.market_data?.current_price?.usd;
  return typeof hp === 'number' && Number.isFinite(hp) && hp > 0 ? hp : null;
}
