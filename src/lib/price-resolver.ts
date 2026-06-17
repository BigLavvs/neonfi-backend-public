// Neonfi backend — canonical price resolver (retrofit-16).
//
// Every exchange client funnels its ticks through recordTick(). The resolver is
// the ONLY writer of the canonical `price:<SYMBOL>` key + channel — the existing
// fan-out path (`ws/server.ts:handlePriceUpdate` subscribes the `price:<SYMBOL>`
// channel) therefore now delivers a cross-exchange resolved price to Pro clients.
//
// Per-exchange ticks are stored at `price:<SYMBOL>:<exchange>`; the canonical
// value is recomputed on each tick by:
//   1. priority — fastest/broadest real-time source first (retrofit-35:
//      binance > coinbase > okx > bybit > gate > kucoin > kraken), and
//   2. freshness — within equal priority, the freshest tick inside a staleness window.
// Stale/expired per-exchange entries are ignored. Kraken's two sub-feeds (last-trade
// `kraken` + bbo-mid `kraken_bbo`) are collapsed by recency before the sort, and a
// cross-source outlier guard drops gross ticker-collision prints (retrofit-35).

import { redis } from './redis.js';
import { config } from './config.js';

const PRICE_TTL_S = 60;
// A per-exchange entry older than this is treated as stale and ignored when
// picking the canonical value (even though its key may still be within TTL).
const STALENESS_WINDOW_MS = 15_000;

// retrofit-20/43: sampled per-symbol price history (`price_hist:<SYMBOL>`) — powers both the
// top-mover sparklines AND the 1H/1D intraday chart ranges (GET /prices/history). Appended at
// most once per symbol every HIST_SAMPLE_MS — a far coarser gate than the per-tick canonical
// writes. retrofit-43 widened the buffer to ~24h (3-min samples × 480 points) and now stores
// each entry as "<tsMs>|<price>" so the chart x-axis uses real timestamps: a quiet symbol that
// skips samples must NOT be drawn as evenly-spaced. Kept to the newest HIST_MAX_POINTS and the
// TTL is refreshed on every sample so a stale symbol's series ages out after 24h. All Redis,
// capped + TTL'd — zero Postgres write load (480 × ~500 symbols × ~30 B ≈ ~7 MB, bounded).
const HIST_SAMPLE_MS = 3 * 60_000; // ≥3 min between samples per symbol
const HIST_MAX_POINTS = 480; // 480 × 3 min = 24h  (LTRIM 0..479)
const HIST_TTL_S = 86_400; // 24h

// retrofit-35: priority = SPEED/breadth of the source's real-time stream. Binance (all-market
// ~1/sec) first; Coinbase next (true-USD, per-trade). OKX/Bybit (retrofit-37) and Gate/KuCoin
// (retrofit-36) fill coverage for coins the top two don't list. Kraken is the true-USD fallback,
// with its bbo-mid sub-feed ('kraken_bbo') MERGED into the 'kraken' candidate below (more-current
// wins) rather than ranked as its own tier. Resolver still picks the highest-priority FRESH source.
const SOURCE_PRIORITY: Record<string, number> = {
  binance: 0,
  coinbase: 1,
  okx: 2,
  bybit: 3,
  gate: 4,
  kucoin: 5,
  kraken: 6,
};
// Every per-exchange key we read back. 'kraken_bbo' is read but collapsed into 'kraken' in
// resolveCanonical (it is NOT a standalone priority tier).
const EXCHANGES = ['binance', 'coinbase', 'okx', 'bybit', 'gate', 'kucoin', 'kraken', 'kraken_bbo'] as const;

// retrofit-35: a fresh source whose price is >RATIO× or <1/RATIO× the median of the fresh set is
// dropped as a likely ticker collision / bad print (only when ≥2 sources are fresh to cross-check).
const PRICE_OUTLIER_RATIO = config.PRICE_OUTLIER_RATIO;

interface ExchangeTick {
  price: number;
  change24h: number;
  quote: string;
  ts: number;
}

// Last PUBLISHED canonical price per symbol — drives the change-dedupe. We publish a
// `price:<SYMBOL>` tick to the firehose only when the resolved price differs from this,
// so identical re-resolutions don't spam clients. In-process Map is fine: a single
// backend process owns the feeds.
const lastPublishedPrice = new Map<string, number>();

// retrofit-20: last history-sample time per symbol — drives the ≥5-min sparkline
// sample gate, independent of the per-tick canonical writes. Same in-process Map
// rationale (single feed-owning process).
const lastHistSampleAt = new Map<string, number>();

/**
 * Record a tick from one exchange. Writes the per-exchange key unconditionally,
 * then recomputes the canonical price (republished only when it actually changed).
 *
 * `now` is injectable so tests can drive the freshness/history logic
 * deterministically; production callers omit it.
 */
export async function recordTick(
  symbol: string,
  exchange: string,
  price: number,
  change24h: number,
  quote: string,
  now: number = Date.now(),
): Promise<void> {
  const sym = symbol.toUpperCase();
  if (!Number.isFinite(price)) return;

  const tick: ExchangeTick = {
    price,
    change24h: Number.isFinite(change24h) ? change24h : 0,
    quote,
    ts: now,
  };
  await redis.set(`price:${sym}:${exchange}`, JSON.stringify(tick), 'EX', PRICE_TTL_S);

  await resolveCanonical(sym, now);
}

/**
 * Recompute the canonical price for one symbol from its per-exchange entries, refresh
 * the canonical read cache, and (only when the resolved price actually moved) publish
 * the new tick to the firehose.
 */
async function resolveCanonical(sym: string, now: number): Promise<void> {
  const keys = EXCHANGES.map((e) => `price:${sym}:${e}`);
  const raws = await redis.mget(...keys);

  // Read each per-exchange entry, applying the staleness filter, into a by-exchange map.
  const fresh = new Map<string, ExchangeTick>();
  raws.forEach((raw, i) => {
    if (!raw) return;
    let tick: ExchangeTick;
    try {
      tick = JSON.parse(raw) as ExchangeTick;
    } catch {
      return;
    }
    if (!Number.isFinite(tick.price)) return;
    if (now - tick.ts > STALENESS_WINDOW_MS) return; // stale — ignore
    fresh.set(EXCHANGES[i]!, tick);
  });

  // retrofit-35: collapse Kraken's two sub-feeds. Prefer the last trade; let the bbo-mid
  // surface only when it is strictly more recent (keeps thin Kraken pairs live without
  // overriding a live trade). `krakenLabel` carries the real source into the payload.
  let krakenLabel: 'kraken' | 'kraken_bbo' = 'kraken';
  const kt = fresh.get('kraken');
  const kb = fresh.get('kraken_bbo');
  if (kt || kb) {
    const useBbo = kt && kb ? kb.ts > kt.ts : !kt;
    fresh.set('kraken', (useBbo ? kb : kt)!);
    krakenLabel = useBbo ? 'kraken_bbo' : 'kraken';
  }
  fresh.delete('kraken_bbo'); // merged — not a standalone candidate

  if (fresh.size === 0) return;

  // retrofit-35: cross-source outlier guard. With ≥2 fresh sources, drop any whose price is
  // outside [median/RATIO, median*RATIO] — a likely ticker collision (a long-tail "FOO" on
  // one venue being a different asset than the catalog "FOO") or a bad print. Runs on ≤7
  // entries, so cost is negligible. If no majority survives (≤1 source agrees with the
  // median), keep the highest-PRIORITY candidate and log — never resolve to zero.
  if (fresh.size >= 2) {
    const prices = [...fresh.values()].map((t) => t.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
    const lo = median / PRICE_OUTLIER_RATIO;
    const hi = median * PRICE_OUTLIER_RATIO;

    const kept = new Map<string, ExchangeTick>();
    for (const [exchange, tick] of fresh) {
      if (tick.price >= lo && tick.price <= hi) {
        kept.set(exchange, tick);
      } else {
        console.warn(JSON.stringify({ event: 'price_outlier_dropped', symbol: sym, exchange, price: tick.price, median }));
      }
    }

    if (kept.size >= 2) {
      // A consensus cluster of ≥2 agreeing sources — resolve from it.
      fresh.clear();
      for (const [k, v] of kept) fresh.set(k, v);
    } else {
      // No majority (sources disagree beyond the ratio). Can't tell which is right —
      // fall back to the highest-PRIORITY fresh source rather than trusting the median.
      let best: [string, ExchangeTick] | null = null;
      for (const entry of fresh) {
        if (!best || (SOURCE_PRIORITY[entry[0]] ?? 99) < (SOURCE_PRIORITY[best[0]] ?? 99)) best = entry;
      }
      console.warn(JSON.stringify({ event: 'price_outlier_no_majority', symbol: sym, kept: best?.[0] ?? null }));
      fresh.clear();
      if (best) fresh.set(best[0], best[1]);
    }
  }

  const candidates = [...fresh.entries()].map(([exchange, tick]) => ({ exchange, tick }));

  // Priority tier first, then freshest within the tier.
  candidates.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.exchange] ?? 99;
    const pb = SOURCE_PRIORITY[b.exchange] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.tick.ts - a.tick.ts;
  });

  const winner = candidates[0]!;
  // Keep the real source label so the firehose `source` stays honest after the Kraken merge.
  const sourceLabel = winner.exchange === 'kraken' ? krakenLabel : winner.exchange;
  const payload = JSON.stringify({
    price: winner.tick.price,
    change24h: winner.tick.change24h,
    source: sourceLabel,
    ts: now,
  });

  // Always refresh the canonical read cache (60s TTL) so the live-price read overlay
  // (lib/live-price.ts) stays warm even across flat-price stretches.
  await redis.set(`price:${sym}`, payload, 'EX', PRICE_TTL_S);

  // Change-dedupe (retrofit-29) — replaces the old time throttle. Publish to the
  // firehose ONLY when the resolved price actually moved from the last value we
  // published for this symbol. Identical re-resolutions (e.g. a non-winning exchange
  // ticks while the winner is unchanged) are dropped so per-tick streaming never spams
  // clients with no-op frames. Stamp the new value BEFORE the await so concurrent
  // identical ticks collapse to a single publish.
  if (lastPublishedPrice.get(sym) !== winner.tick.price) {
    lastPublishedPrice.set(sym, winner.tick.price);
    await redis.publish(`price:${sym}`, payload);
  }

  // retrofit-20/43: append the winning price to a capped per-symbol history list, sampled at
  // ≥3 min (a separate, coarser gate than the per-tick canonical writes) so 480 points span
  // ~24h. Each entry is "<tsMs>|<price>" (retrofit-43) so the intraday chart can place samples
  // on a real time axis rather than assuming even spacing. Stamp the sample time BEFORE the
  // await (same collapse-concurrent-ticks reasoning as the publish dedupe). Best-effort: a
  // history failure must never break the canonical price path, so the chain is fully
  // `.catch`-swallowed.
  const lastHist = lastHistSampleAt.get(sym) ?? 0;
  if (now - lastHist >= HIST_SAMPLE_MS) {
    lastHistSampleAt.set(sym, now);
    await redis
      .lpush(`price_hist:${sym}`, `${now}|${winner.tick.price}`)
      .then(() => redis.ltrim(`price_hist:${sym}`, 0, HIST_MAX_POINTS - 1))
      .then(() => redis.expire(`price_hist:${sym}`, HIST_TTL_S))
      .catch(() => {
        /* intraday history is best-effort */
      });
  }
}

/** Test-only: reset the change-dedupe + history-sample bookkeeping between cases. */
export function __resetThrottleForTest(): void {
  lastPublishedPrice.clear();
  lastHistSampleAt.clear();
}

export const __internals = {
  STALENESS_WINDOW_MS,
  PRICE_TTL_S,
  SOURCE_PRIORITY,
  EXCHANGES,
  PRICE_OUTLIER_RATIO,
  HIST_SAMPLE_MS,
  HIST_MAX_POINTS,
  HIST_TTL_S,
};
