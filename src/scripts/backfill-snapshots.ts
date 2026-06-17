// retrofit-41/42 — one-off, idempotent snapshot-history backfill.
//
// Every time-series chart is empty on a fresh/dev DB: snapshot.job.ts only ever writes
// balance_snapshot (Pro-only) and token_price_snapshot GOING FORWARD, one row per UTC day,
// and the cron only fires while the process is alive at midnight UTC (never replays misses).
// With no history the dashboard "Portfolio Value" chart, the token-detail price charts and the
// performance charts all show "Not enough history yet". The READ paths are NOT plan-gated
// (overview.service → findAllSnapshotsAscByPortfolio; token history → token_price_snapshot), so
// inserting historical rows makes the charts render for any plan.
//
// retrofit-42 swaps retrofit-41's purely-synthetic seed for REAL daily history where we can get
// it (CoinGecko), keeping a synthetic fallback so every chart still renders:
//   1. Build a symbol → CoinGecko-id map from /coins/markets (top ~750 by market cap; a colliding
//      ticker resolves to the highest-market-cap coin — the retrofit-40 rank-priority lesson).
//   2. Per token, in PRIORITY order (held tokens ALWAYS, then catalog by rank, up to
//      REAL_HISTORY_LIMIT): fetch /coins/{id}/market_chart?days=365 (free tier auto-returns DAILY
//      granularity for days>90 — do NOT send interval=daily, that's paid), collapse to one price
//      per UTC date, and upsert token_price_snapshot. A token with no mapped id / a fetch that
//      keeps failing / a token past the limit falls back to a deterministic synthetic random walk
//      ending on its current price.
//   3. Per-portfolio daily value = Σ(current balance × that-day price) using whichever series each
//      held token ended up with, for EVERY portfolio (the read isn't Pro-gated). (Simplification:
//      uses CURRENT balances for all past days — a demo curve, not a holdings reconstruction.)
//   4. Invalidate the affected derived caches + per-user overview caches.
//
// IDEMPOTENT: synthetic series use a per-tokenId-seeded PRNG (same curve every run) and real series
// are deterministic given the same upstream data; both write via ON CONFLICT DO UPDATE — re-running
// yields the same rows and (barring upstream price moves) the same values.
//
// Ongoing snapshots remain Pro-gated in snapshot.job.ts (write side). Run: `npm run backfill:snapshots`.

import { pathToFileURL } from 'node:url';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { config } from '../lib/config.js';
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';

export const DAYS = 365;
const DAILY_VOL = 0.025; // ~2.5%/day — plausible crypto volatility (synthetic fallback)
// Bulk-insert chunk size. ≤4 params/row × 1000 = 4000 bind params/statement, well under
// Postgres' 65535 limit, and keeps each round-trip cheap under Neon's per-query latency.
const CHUNK = 1000;
// /coins/markets pagination — top ~750 coins by market cap is plenty to cover any catalog ticker.
const MARKETS_PAGES = 3;
const MARKETS_PER_PAGE = 250;
const BACKOFF_MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// CoinGecko source — injectable so tests mock it (no live network in tests).
// ---------------------------------------------------------------------------

export interface CoinGeckoMarket {
  id: string;
  symbol: string; // CoinGecko symbols are lowercase
  marketCap: number;
}
export interface CoinGeckoSource {
  fetchMarkets(): Promise<CoinGeckoMarket[]>;
  // [tsMs, price] points (ascending by ts); [] when unavailable.
  fetchMarketChart(id: string): Promise<Array<[number, number]>>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Real HTTP CoinGecko client. Demo key (when set) uses the same public base with the
// `x-cg-demo-api-key` header; retries 429 with exponential backoff.
class HttpCoinGeckoSource implements CoinGeckoSource {
  constructor(
    private readonly base: string,
    private readonly apiKey: string | undefined,
    private readonly throttleMs: number,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) h['x-cg-demo-api-key'] = this.apiKey;
    return h;
  }

  private async getJson(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}${path}`, { headers: this.headers() });
      if (res.status === 429) {
        if (attempt >= BACKOFF_MAX_RETRIES) {
          throw new Error(`CoinGecko 429 after ${attempt} retries: ${path}`);
        }
        const backoff = Math.min(60_000, 2 ** (attempt + 1) * 1000);
        console.warn(`[backfill:snapshots] CoinGecko 429 — backoff ${backoff}ms (retry ${attempt + 1})`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        throw new Error(`CoinGecko HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return res.json();
    }
  }

  async fetchMarkets(): Promise<CoinGeckoMarket[]> {
    const out: CoinGeckoMarket[] = [];
    for (let page = 1; page <= MARKETS_PAGES; page++) {
      const rows = (await this.getJson(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MARKETS_PER_PAGE}&page=${page}`,
      )) as Array<{ id: string; symbol: string; market_cap: number | null }>;
      for (const r of rows) out.push({ id: r.id, symbol: r.symbol, marketCap: r.market_cap ?? 0 });
      if (page < MARKETS_PAGES) await sleep(this.throttleMs);
    }
    return out;
  }

  async fetchMarketChart(id: string): Promise<Array<[number, number]>> {
    // days=365 → free tier auto-returns DAILY granularity. interval=daily is paid-only (401).
    const body = (await this.getJson(
      `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365`,
    )) as { prices?: Array<[number, number]> };
    return body.prices ?? [];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly).
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32). Seeded per tokenId so every run reproduces the same synthetic
// series for a given token → re-running is truly idempotent (same values, not just row count).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic fallback: walk BACKWARD from currentPrice so out[DAYS-1] is today's real price and the
// series drifts plausibly before it. index 0 = oldest day, DAYS-1 = today.
export function seriesFor(currentPrice: number, tokenId: number): number[] {
  const rng = mulberry32(tokenId);
  const out = new Array<number>(DAYS);
  out[DAYS - 1] = currentPrice; // today = real price
  for (let i = DAYS - 2; i >= 0; i--) {
    const r = (rng() * 2 - 1) * DAILY_VOL; // ±vol
    out[i] = Math.max(1e-8, out[i + 1]! * (1 - r)); // step backward, never ≤ 0
  }
  return out;
}

// symbol(lowercase) → CoinGecko id. A ticker collision resolves to the HIGHEST-market-cap coin
// (markets are returned market_cap_desc, but we pick by max marketCap explicitly so the result is
// order-independent — the canonical coin wins even on an unsorted input).
export function buildSymbolIdMap(markets: CoinGeckoMarket[]): Map<string, string> {
  const bestCap = new Map<string, number>();
  const map = new Map<string, string>();
  for (const m of markets) {
    const sym = m.symbol.toLowerCase();
    const prev = bestCap.get(sym);
    if (prev === undefined || m.marketCap > prev) {
      bestCap.set(sym, m.marketCap);
      map.set(sym, m.id);
    }
  }
  return map;
}

// Collapse raw [tsMs, price] points to a DAYS-length series aligned to ymdByIndex (index 0 oldest,
// DAYS-1 today). One price per UTC date (last point of each day wins); gaps forward-filled, leading
// dates back-filled from the first known price; the last slot is forced to the latest real price so
// the series provably ENDS on it. Returns null when there are no usable points (→ caller falls back).
export function buildRealSeries(
  prices: Array<[number, number]>,
  ymdByIndex: string[],
): number[] | null {
  const byDate = new Map<string, number>();
  for (const [ts, price] of prices) {
    if (price == null || !Number.isFinite(price)) continue;
    byDate.set(new Date(ts).toISOString().slice(0, 10), price); // ascending ts → last/day wins
  }
  if (byDate.size === 0) return null;
  const dates = [...byDate.keys()].sort();
  const firstKnown = byDate.get(dates[0]!)!;
  const latest = byDate.get(dates[dates.length - 1]!)!;

  const out = new Array<number>(DAYS);
  let carry = firstKnown; // leading dates (older than coverage) back-fill from the oldest known
  for (let i = 0; i < DAYS; i++) {
    const d = ymdByIndex[i]!;
    if (byDate.has(d)) carry = byDate.get(d)!;
    out[i] = carry;
  }
  out[DAYS - 1] = latest; // ensure the series ends on the latest real price
  return out;
}

// 'YYYY-MM-DD' (UTC) for `today − offset` days. The columns are @db.Date, so we pin each row to an
// unambiguous calendar day regardless of server timezone — and the same string re-targets the same
// row on a re-run (composite-PK upsert).
function dateStringForOffset(todayMidnightUtcMs: number, offsetDays: number): string {
  return new Date(todayMidnightUtcMs - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// price/value → fixed 8dp string (the columns are Decimal(20,8)). toFixed avoids scientific
// notation (e.g. a 1e-8 floor would serialize as "1e-8" and break the ::decimal cast).
function dec8(n: number): string {
  return n.toFixed(8);
}

async function bulkUpsert(
  table: 'token_price_snapshot' | 'balance_snapshot',
  rows: Prisma.Sql[],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    if (table === 'token_price_snapshot') {
      written += await prisma.$executeRaw`
        INSERT INTO "token_price_snapshot" ("tokenId", "price", "snapshotDate")
        VALUES ${Prisma.join(chunk)}
        ON CONFLICT ("tokenId", "snapshotDate") DO UPDATE SET "price" = EXCLUDED."price"
      `;
    } else {
      written += await prisma.$executeRaw`
        INSERT INTO "balance_snapshot" ("portfolioId", "userId", "value", "snapshotDate")
        VALUES ${Prisma.join(chunk)}
        ON CONFLICT ("portfolioId", "snapshotDate") DO UPDATE SET "value" = EXCLUDED."value"
      `;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------

export interface BackfillSnapshotsResult {
  mapped: number; // catalog symbols resolved to a CoinGecko id
  realTokens: number; // tokens that got REAL daily history
  syntheticFallback: number; // tokens that got a synthetic series (unmapped/failed/long-tail)
  tokenRows: number; // token_price_snapshot rows written (= catalog tokens × DAYS)
  portfolioRows: number; // balance_snapshot rows written (= portfolios × DAYS)
}

export interface BackfillSnapshotsOpts {
  source?: CoinGeckoSource; // injected in tests
  throttleMs?: number; // delay between real per-token fetches (0 in tests)
  realHistoryLimit?: number; // overrides config.REAL_HISTORY_LIMIT
}

export async function runSnapshotsBackfill(opts: BackfillSnapshotsOpts = {}): Promise<BackfillSnapshotsResult> {
  const throttleMs = opts.throttleMs ?? (config.COINGECKO_API_KEY ? 2500 : 6000);
  const source = opts.source ?? new HttpCoinGeckoSource(config.COINGECKO_BASE, config.COINGECKO_API_KEY, throttleMs);
  const realHistoryLimit = opts.realHistoryLimit ?? config.REAL_HISTORY_LIMIT;

  // Anchor every date to today's UTC midnight; precompute the date string for each series index
  // once (shared by both tables). index i → date = today − (DAYS-1-i) days, so ymd[DAYS-1] = today.
  const todayMidnightUtcMs = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  const ymdByIndex = new Array<string>(DAYS);
  for (let i = 0; i < DAYS; i++) ymdByIndex[i] = dateStringForOffset(todayMidnightUtcMs, DAYS - 1 - i);

  // ----- Load catalog + held tokens ---------------------------------------------------
  const tokens = await prisma.token.findMany({ select: { id: true, symbol: true, currentPrice: true, rank: true } });
  const heldRows = await prisma.asset.findMany({ select: { tokenId: true }, distinct: ['tokenId'] });
  const heldIds = new Set(heldRows.map((a) => a.tokenId));

  // ----- Step 1: symbol → CoinGecko id ------------------------------------------------
  let symbolIdMap = new Map<string, string>();
  try {
    symbolIdMap = buildSymbolIdMap(await source.fetchMarkets());
  } catch (e) {
    console.error('[backfill:snapshots] /coins/markets failed — every token will use a synthetic series:', (e as Error).message);
  }
  const idForToken = (symbol: string): string | undefined => symbolIdMap.get(symbol.toLowerCase());
  const mapped = tokens.filter((t) => idForToken(t.symbol)).length;

  // ----- Priority order: held tokens ALWAYS, then catalog by rank, capped at the limit -----
  const byRank = [...tokens].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const held = byRank.filter((t) => heldIds.has(t.id));
  const nonHeld = byRank.filter((t) => !heldIds.has(t.id));
  const fill = Math.max(0, realHistoryLimit - held.length);
  const targeted = new Set([...held, ...nonHeld.slice(0, fill)].map((t) => t.id));
  const priorityOrder = [...held, ...nonHeld]; // fetch held first so rate-limits hit the long tail

  // ----- Step 2: build a series per token (real where possible, synthetic otherwise) -----
  const seriesByToken = new Map<number, { series: number[]; isReal: boolean; currentPrice: string }>();
  const fallbackSymbols: string[] = [];
  let realTokens = 0;
  let realFetches = 0;
  for (const t of priorityOrder) {
    const curr = Number(t.currentPrice.toString());
    const cgId = idForToken(t.symbol);
    let series: number[] | null = null;

    if (targeted.has(t.id) && cgId) {
      if (realFetches > 0) await sleep(throttleMs); // throttle between real fetches
      realFetches++;
      try {
        series = buildRealSeries(await source.fetchMarketChart(cgId), ymdByIndex);
        if (!series) fallbackSymbols.push(t.symbol); // mapped but no usable points
      } catch (e) {
        console.warn(`[backfill:snapshots] real history failed for ${t.symbol} (${cgId}) — synthetic:`, (e as Error).message);
        fallbackSymbols.push(t.symbol);
      }
    } else if (targeted.has(t.id) && !cgId) {
      fallbackSymbols.push(t.symbol); // targeted but no CoinGecko mapping
    }

    if (series) {
      realTokens++;
      seriesByToken.set(t.id, { series, isReal: true, currentPrice: t.currentPrice.toString() });
    } else {
      seriesByToken.set(t.id, { series: seriesFor(curr, t.id), isReal: false, currentPrice: t.currentPrice.toString() });
    }
  }
  if (fallbackSymbols.length > 0) {
    console.warn(`[backfill:snapshots] synthetic fallback for ${fallbackSymbols.length} targeted token(s): ${fallbackSymbols.join(', ')}`);
  }

  // Build + upsert token_price_snapshot rows.
  const tokenRowSql: Prisma.Sql[] = [];
  for (const t of tokens) {
    const entry = seriesByToken.get(t.id)!;
    for (let i = 0; i < DAYS; i++) {
      // Synthetic series end exactly on the stored Decimal currentPrice; real series end on the
      // latest real price (already in series[DAYS-1]).
      const priceStr = i === DAYS - 1 && !entry.isReal ? entry.currentPrice : dec8(entry.series[i]!);
      tokenRowSql.push(Prisma.sql`(${t.id}::int, ${priceStr}::decimal, ${ymdByIndex[i]!}::date)`);
    }
  }
  const tokenRows = await bulkUpsert('token_price_snapshot', tokenRowSql);

  // ----- Step 3: per-portfolio daily value --------------------------------------------
  const portfolios = await prisma.portfolio.findMany({
    select: { id: true, userId: true, assets: { select: { tokenId: true, balance: true } } },
  });
  const balanceRowSql: Prisma.Sql[] = [];
  for (const p of portfolios) {
    const holdings = p.assets.map((a) => ({
      balance: Number(a.balance.toString()),
      series: seriesByToken.get(a.tokenId)?.series,
    }));
    for (let i = 0; i < DAYS; i++) {
      let value = 0;
      for (const h of holdings) if (h.series) value += h.balance * h.series[i]!;
      balanceRowSql.push(
        Prisma.sql`(${p.id}::int, ${p.userId}::int, ${dec8(value)}::decimal, ${ymdByIndex[i]!}::date)`,
      );
    }
  }
  const portfolioRows = await bulkUpsert('balance_snapshot', balanceRowSql);

  // ----- Step 4: invalidate read caches so the next chart load recomputes -------------
  // Best-effort: a Redis hiccup must not undo a successful backfill. Two layers, mirroring
  // prices.service.invalidateUserReadCaches: the per-portfolio derived caches (portfolio_pnl +
  // analytics_*) and the per-user overview response cache (every days/txLimit variant).
  try {
    const derivedKeys = portfolios.flatMap((p) => portfolioDerivedCacheKeys(p.id));
    if (derivedKeys.length > 0) await redis.del(...derivedKeys);
    const userIds = [...new Set(portfolios.map((p) => p.userId))];
    for (const uid of userIds) {
      const overviewKeys = await redis.keys(`overview:${uid}:*`);
      if (overviewKeys.length > 0) await redis.del(...overviewKeys);
    }
  } catch (e) {
    console.error('[backfill:snapshots] cache invalidation failed (non-fatal):', (e as Error).message);
  }

  const result: BackfillSnapshotsResult = {
    mapped,
    realTokens,
    syntheticFallback: tokens.length - realTokens,
    tokenRows,
    portfolioRows,
  };
  console.log(JSON.stringify({ event: 'snapshots_backfill_done', ...result }));
  return result;
}

// CLI entry (mirrors backfill-costbasis.ts). Only runs when invoked directly, NOT when imported by
// a test — pathToFileURL(argv[1]) is the cross-platform ESM main-module check (handles Windows
// `file:///C:/…`).
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runSnapshotsBackfill()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[backfill:snapshots] failed:', e);
      process.exit(1);
    });
}
