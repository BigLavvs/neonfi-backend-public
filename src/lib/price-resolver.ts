// Neonfi backend — canonical price resolver (retrofit-16).
//
// Every exchange client funnels its ticks through recordTick(). The resolver is
// the ONLY writer of the canonical `price:<SYMBOL>` key + channel — the existing
// fan-out path (`ws/server.ts:handlePriceUpdate` subscribes the `price:<SYMBOL>`
// channel) therefore now delivers a cross-exchange resolved price to Pro clients.
//
// Per-exchange ticks are stored at `price:<SYMBOL>:<exchange>`; the canonical
// value is recomputed on each tick by:
//   1. priority — true-USD sources (coinbase, kraken) beat USDT (binance), and
//   2. freshness — within a tier, the freshest tick inside a staleness window.
// Stale/expired per-exchange entries are ignored.

import { redis } from './redis.js';

const PRICE_TTL_S = 60;
// A per-exchange entry older than this is treated as stale and ignored when
// picking the canonical value (even though its key may still be within TTL).
const STALENESS_WINDOW_MS = 15_000;

// retrofit-20: sampled per-symbol price history for sparklines (`price_hist:<SYMBOL>`).
// Appended at most once per symbol every HIST_SAMPLE_MS so the capped list spans hours,
// not seconds — a far coarser gate than the per-tick canonical writes. Kept to the newest
// HIST_MAX_POINTS and expired after HIST_TTL_S so a quiet symbol's series ages out.
const HIST_SAMPLE_MS = 5 * 60_000; // ≥5 min between samples per symbol
const HIST_MAX_POINTS = 12; // LTRIM 0..11
const HIST_TTL_S = 86_400; // 1 day

// Resolver priority TIERS: lower number wins. The true-USD sources (coinbase,
// kraken) share the top tier — between them the freshest tick wins. Binance is
// the lower tier (USDT-quoted ≈ USD approximation), used only as a fallback.
const SOURCE_PRIORITY: Record<string, number> = {
  coinbase: 0,
  kraken: 0,
  binance: 1,
};
// The exchanges we read back when recomputing the canonical value.
const EXCHANGES = ['coinbase', 'kraken', 'binance'] as const;

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

  const candidates: Array<{ exchange: string; tick: ExchangeTick }> = [];
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
    candidates.push({ exchange: EXCHANGES[i]!, tick });
  });

  if (candidates.length === 0) return;

  // Priority tier first, then freshest within the tier.
  candidates.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.exchange] ?? 99;
    const pb = SOURCE_PRIORITY[b.exchange] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.tick.ts - a.tick.ts;
  });

  const winner = candidates[0]!;
  const payload = JSON.stringify({
    price: winner.tick.price,
    change24h: winner.tick.change24h,
    source: winner.exchange,
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

  // retrofit-20: append the winning price to a capped per-symbol history list for
  // sparklines, sampled at ≥5 min (a separate, coarser gate than the per-tick canonical
  // writes) so ~12 points span hours, not seconds. Stamp the sample time BEFORE the
  // await (same collapse-concurrent-ticks reasoning as the publish dedupe). Best-effort: a
  // history failure must never break the canonical price path, so the chain is fully
  // `.catch`-swallowed.
  const lastHist = lastHistSampleAt.get(sym) ?? 0;
  if (now - lastHist >= HIST_SAMPLE_MS) {
    lastHistSampleAt.set(sym, now);
    await redis
      .lpush(`price_hist:${sym}`, String(winner.tick.price))
      .then(() => redis.ltrim(`price_hist:${sym}`, 0, HIST_MAX_POINTS - 1))
      .then(() => redis.expire(`price_hist:${sym}`, HIST_TTL_S))
      .catch(() => {
        /* sparkline history is best-effort */
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
  HIST_SAMPLE_MS,
  HIST_MAX_POINTS,
  HIST_TTL_S,
};
