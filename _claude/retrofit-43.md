# retrofit-43 — Intraday price history (Redis-only) for 1H/1D charts

## Why
The 1H and 1D/24H chart ranges have no real data: snapshots are **daily** granularity
(`snapshot.job.ts`, PK on a `@db.Date` column), so any range ≤ 1 day has 0–1 points. Today the
dashboard renders those ranges empty and the performance + token charts silently fall back to the
full ~1-year series under a "1H"/"24H" label (misleading).

The fix must add **zero Postgres write load** (the whole tick path is already Postgres-free —
`price-resolver.ts` only touches Redis; no exchange client imports Prisma; `Token.currentPrice` is
written only by the 6-hourly catalog sync). We already have the right primitive: the resolver writes
a capped, TTL'd, sampled Redis list `price_hist:<SYMBOL>` (retrofit-20) that powers the top-mover
sparklines. This retrofit **widens that buffer to ~24h, timestamps each sample, and exposes it via a
read endpoint** so the frontend can reconstruct intraday portfolio value = Σ(balance × price[t]).
All Redis, capped + TTL'd — no new table, no migration, no Postgres growth.

---

## Part A — widen + timestamp the `price_hist:<SYM>` buffer

File: `src/lib/price-resolver.ts`

Current (retrofit-20, ~lines 25-31 and ~214-230):
```ts
const HIST_SAMPLE_MS = 5 * 60_000; // ≥5 min between samples per symbol
const HIST_MAX_POINTS = 12;        // LTRIM 0..11
const HIST_TTL_S = 86_400;         // 1 day
...
await redis
  .lpush(`price_hist:${sym}`, String(winner.tick.price))
  .then(() => redis.ltrim(`price_hist:${sym}`, 0, HIST_MAX_POINTS - 1))
  .then(() => redis.expire(`price_hist:${sym}`, HIST_TTL_S))
  .catch(() => { /* sparkline history is best-effort */ });
```

Change to:
```ts
// retrofit-43: intraday buffer. 3-min samples × 480 points = 24h span. Each entry is
// "<tsMs>|<price>" so the chart x-axis uses real timestamps (a quiet symbol that skips
// samples must not be drawn as evenly-spaced). Newest-first (LPUSH + LTRIM 0..MAX-1),
// TTL refreshed each sample so a stale symbol's series ages out after 24h.
const HIST_SAMPLE_MS = 3 * 60_000; // ≥3 min between samples per symbol
const HIST_MAX_POINTS = 480;       // 480 × 3 min = 24h  (LTRIM 0..479)
const HIST_TTL_S = 86_400;         // 24h
...
await redis
  .lpush(`price_hist:${sym}`, `${now}|${winner.tick.price}`)
  .then(() => redis.ltrim(`price_hist:${sym}`, 0, HIST_MAX_POINTS - 1))
  .then(() => redis.expire(`price_hist:${sym}`, HIST_TTL_S))
  .catch(() => { /* intraday history is best-effort */ });
```
Keep the existing `lastHistSampleAt` gate and the "stamp BEFORE the await" ordering exactly as-is.
`now` is already in scope in `recordTick`/`resolveCanonical`; reuse it (do not call `Date.now()` again
mid-function). Update the header comment block (lines ~25-28) to describe the new format/extent.

Memory envelope (sanity, not a task): 480 pts × ~500 symbols × ~30 B ≈ ~7 MB Redis, capped — fine.
These three constants are the tuning knobs; leaving them as module constants is fine.

## Part B — keep the sparkline reader working (new format)

File: `src/modules/overview/overview.service.ts` (~lines 166-173, the `sparks` block).

The entries are now `"<ts>|<price>"`, so `Number(entry)` → NaN and sparklines would vanish. Parse the
price half, tolerating any legacy price-only entries still within TTL:
```ts
// retrofit-43: entries are "<ts>|<price>" (was bare price pre-43). Take the price half;
// fall back to parsing the whole token so legacy entries within TTL still render.
const parsePrice = (s: string): number => {
  const bar = s.indexOf('|');
  return Number(bar >= 0 ? s.slice(bar + 1) : s);
};
const sparks = await Promise.all(
  top.map((m) =>
    redis
      .lrange(`price_hist:${m.symbol}`, 0, -1)
      .then((rawHist) => rawHist.map(parsePrice).filter(Number.isFinite).reverse())
      .catch(() => [] as number[]),
  ),
);
```
Behaviour is otherwise identical (oldest→newest numeric prices for the spark).

## Part C — new read endpoint `GET /prices/history`

Symbol-keyed intraday series from the buffer. Auth-required, **NOT Pro-gated** (catalog price data,
read-only — same stance as `GET /tokens/:id/history`, which has "no plan gate").

### `src/modules/prices/prices.schemas.ts` — add
```ts
export const historyQuerySchema = z.object({
  // comma-separated, case-insensitive; capped to 50 to bound the LRANGE fan-out
  symbols: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))].slice(0, 50)),
  range: z.enum(['1H', '1D']).default('1H'),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
```

### `src/modules/prices/prices.service.ts` — add
```ts
const RANGE_MS: Record<'1H' | '1D', number> = { '1H': 60 * 60_000, '1D': 24 * 60 * 60_000 };

export interface PricePoint { t: number; p: number; }

// Read the sampled intraday buffer for each symbol, filter to the requested window, return
// oldest→newest. Redis-only (no Postgres). A missing/empty key → []. `now` injectable for tests.
export async function getPriceHistory(
  symbols: string[],
  range: '1H' | '1D',
  now: number = Date.now(),
): Promise<Record<string, PricePoint[]>> {
  const cutoff = now - RANGE_MS[range];
  const out: Record<string, PricePoint[]> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const raw = await redis.lrange(`price_hist:${sym}`, 0, -1); // newest→oldest
        const pts: PricePoint[] = [];
        for (const entry of raw) {
          const bar = entry.indexOf('|');
          if (bar < 0) continue; // legacy price-only entry has no usable ts — skip
          const t = Number(entry.slice(0, bar));
          const p = Number(entry.slice(bar + 1));
          if (Number.isFinite(t) && Number.isFinite(p) && p > 0 && t >= cutoff) pts.push({ t, p });
        }
        pts.reverse(); // oldest→newest for charting
        out[sym] = pts;
      } catch {
        out[sym] = []; // Redis hiccup → empty series, never throws
      }
    }),
  );
  return out;
}
```

### `src/modules/prices/prices.controller.ts` — add route
```ts
import { historyQuerySchema } from './prices.schemas.js';
import { /* existing */ getPriceHistory } from './prices.service.js';

// GET /api/v1/prices/history?symbols=BTC,ETH&range=1H — sampled intraday price series per symbol,
// from the resolver's Redis buffer (≤24h, 3-min samples). Auth-required, not Pro-gated (read-only
// catalog price data). Powers the 1H/1D chart ranges; daily snapshots still power 1W+.
pricesRouter.get('/history', requireAuth, async (c) => {
  let q: { symbols: string[]; range: '1H' | '1D' };
  try {
    q = historyQuerySchema.parse({
      symbols: c.req.query('symbols') ?? '',
      range: c.req.query('range') ?? '1H',
    });
  } catch {
    return c.json(err('VALIDATION_ERROR', 'symbols required; range must be 1H or 1D'), 400);
  }
  if (q.symbols.length === 0) return c.json(ok({ history: {} }), 200);
  const history = await getPriceHistory(q.symbols, q.range);
  return c.json(ok({ history }), 200);
});
```
(Reuses the existing `ok`/`err` envelope + `requireAuth` already imported in this file.)

## Part D — tests
Mock Redis as the existing prices/overview suites do (no live Redis/network). Cover:
1. **Resolver buffer**: two ticks spaced ≥ `HIST_SAMPLE_MS` push two `"<ts>|<price>"` entries
   (newest-first); a second tick within the gate adds none; list never exceeds `HIST_MAX_POINTS`
   (LTRIM args asserted); `EXPIRE` called with `HIST_TTL_S`.
2. **Sparkline reader**: a list of `"<ts>|<price>"` entries yields the numeric prices oldest→newest;
   a legacy bare-price entry still parses; a malformed entry is dropped.
3. **getPriceHistory**: filters to the window (entry older than cutoff excluded), returns
   oldest→newest `{t,p}`; unknown symbol → `[]`; a Redis throw → `[]` (never throws); symbols cap at 50.
4. **Endpoint**: missing `symbols` → 400; valid → `{ data: { history: { SYM: [...] } } }`; behind
   `requireAuth`.
`tsc --noEmit` clean; full suite green; `NODE_ENV=test`; dev server stopped.

## Commit & run
Commit named files only:
`src/lib/price-resolver.ts`, `src/modules/overview/overview.service.ts`,
`src/modules/prices/prices.controller.ts`, `src/modules/prices/prices.service.ts`,
`src/modules/prices/prices.schemas.ts`, and the new/updated tests. Report the SHA.
**No DB migration** (Redis-only). Leave the dev server stopped.

## After it lands
`GET /api/v1/prices/history?symbols=BTC&range=1H` returns the last hour of sampled BTC prices. The
buffer fills going forward only (max 24h via TTL), so right after a backend (re)start 1H is sparse
until ~an hour of samples accrue — expected, and the cost of not writing per-tick to Postgres. The
frontend (separate change) reconstructs portfolio value from these series for the 1H/1D ranges and
keeps daily snapshots for 1W/1M/1Y/ALL.
