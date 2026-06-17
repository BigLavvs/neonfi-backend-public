// Neonfi backend — canonical price resolver tests (retrofit-16).
//
// Redis is replaced with an in-memory store (vi.hoisted so the factory can close
// over it) — recordTick's per-exchange writes land in `store`, and canonical
// publishes are captured in `published`. `now` is injected for deterministic
// dedupe/freshness behavior.

import { it, expect, describe, beforeEach, vi } from 'vitest';

const { store, lists, published } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  // retrofit-20: list-typed keys (price_hist:*) live in their own store so the string
  // KV ops (set/get/mget) and the list ops (lpush/ltrim/lrange) don't collide.
  lists: new Map<string, string[]>(),
  published: [] as Array<{ channel: string; message: string }>,
}));

// Resolve a possibly-negative LRANGE/LTRIM stop index against a list length (Redis
// semantics: -1 == last element).
function resolveStop(len: number, stop: number): number {
  return stop < 0 ? len + stop : stop;
}

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
    // LPUSH: each value is inserted at the head in turn, so `LPUSH k a b` → [b, a, …].
    lpush: vi.fn(async (key: string, ...vals: string[]) => {
      const cur = lists.get(key) ?? [];
      cur.unshift(...[...vals].reverse());
      lists.set(key, cur);
      return cur.length;
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const cur = lists.get(key) ?? [];
      lists.set(key, cur.slice(start, resolveStop(cur.length, stop) + 1));
      return 'OK';
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const cur = lists.get(key) ?? [];
      return cur.slice(start, resolveStop(cur.length, stop) + 1);
    }),
    expire: vi.fn(async () => 1),
  },
}));

import { recordTick, __resetThrottleForTest, __internals } from '../src/lib/price-resolver.js';

function canonical(sym: string): { price: number; change24h: number; source: string; ts: number } | null {
  const raw = store.get(`price:${sym}`);
  return raw ? JSON.parse(raw) : null;
}

function publishCount(sym: string): number {
  return published.filter((p) => p.channel === `price:${sym}`).length;
}

beforeEach(() => {
  store.clear();
  lists.clear();
  published.length = 0;
  __resetThrottleForTest();
});

describe('recordTick → canonical resolution', () => {
  it('writes the per-exchange key AND the canonical key, and publishes', async () => {
    const now = 1_000_000;
    await recordTick('BTC', 'binance', 100, 1.5, 'USDT', now);

    const perExchange = JSON.parse(store.get('price:BTC:binance')!);
    expect(perExchange).toMatchObject({ price: 100, change24h: 1.5, quote: 'USDT', ts: now });

    const canon = canonical('BTC');
    expect(canon).toMatchObject({ price: 100, change24h: 1.5, source: 'binance' });
    expect(publishCount('BTC')).toBe(1);
  });

  it('true-USD (kraken) beats binance even when binance is equally fresh', async () => {
    const now = 2_000_000;
    store.set('price:BTC:binance', JSON.stringify({ price: 100, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('BTC', 'kraken', 101, 2, 'USD', now);

    expect(canonical('BTC')).toMatchObject({ price: 101, source: 'kraken' });
  });

  it('coinbase beats kraken when both are fresh (speed priority, retrofit-32)', async () => {
    const now = 3_000_000;
    store.set('price:ETH:kraken', JSON.stringify({ price: 200, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('ETH', 'coinbase', 201, 2, 'USD', now);

    expect(canonical('ETH')).toMatchObject({ price: 201, source: 'coinbase' });
  });

  it('coinbase wins even when kraken is FRESHER — priority beats freshness across sources', async () => {
    const now = 3_500_000;
    // coinbase is 5s old but still inside the 15s staleness window; kraken is bang up to date.
    store.set('price:ETH:coinbase', JSON.stringify({ price: 201, change24h: 2, quote: 'USD', ts: now - 5_000 }));

    await recordTick('ETH', 'kraken', 200, 1, 'USD', now);

    // Speed priority (coinbase=0) wins over the fresher kraken tick (kraken=1).
    expect(canonical('ETH')).toMatchObject({ price: 201, source: 'coinbase' });
  });

  it('kraken is used when coinbase is stale (outside the staleness window)', async () => {
    const now = 4_000_000;
    // coinbase tick is 20s old → outside the 15s staleness window → ignored
    store.set('price:ETH:coinbase', JSON.stringify({ price: 999, change24h: 0, quote: 'USD', ts: now - 20_000 }));

    await recordTick('ETH', 'kraken', 202, 1, 'USD', now);

    expect(canonical('ETH')).toMatchObject({ price: 202, source: 'kraken' });
  });

  it('kraken is used when coinbase is absent', async () => {
    const now = 4_500_000;
    await recordTick('ETH', 'kraken', 203, 1, 'USD', now);

    expect(canonical('ETH')).toMatchObject({ price: 203, source: 'kraken' });
  });

  it('binance is used only when it is the sole fresh source', async () => {
    const now = 5_000_000;
    // kraken stale → ignored; binance fresh → wins despite lowest priority
    store.set('price:SOL:kraken', JSON.stringify({ price: 150, change24h: 1, quote: 'USD', ts: now - 30_000 }));

    await recordTick('SOL', 'binance', 151, 2, 'USDT', now);

    expect(canonical('SOL')).toMatchObject({ price: 151, source: 'binance' });
  });

  it('full priority order with all three fresh → coinbase wins; binance never used', async () => {
    const now = 5_500_000;
    store.set('price:SOL:coinbase', JSON.stringify({ price: 150, change24h: 1, quote: 'USD', ts: now }));
    store.set('price:SOL:kraken', JSON.stringify({ price: 151, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('SOL', 'binance', 152, 2, 'USDT', now);

    expect(canonical('SOL')).toMatchObject({ price: 150, source: 'coinbase' });
  });
});

describe('change-dedupe (replaces the old time throttle)', () => {
  it('rapid CHANGING ticks each publish — no time-gate collapses them', async () => {
    const base = 6_000_000;
    // 10 ticks just 1ms apart, each a distinct price. Under the old 100ms throttle these
    // collapsed to a single publish; with per-tick streaming every move publishes.
    for (let i = 0; i < 10; i++) {
      await recordTick('SOL', 'binance', 10 + i, 1, 'USDT', base + i);
    }
    expect(publishCount('SOL')).toBe(10);
    expect(canonical('SOL')).toMatchObject({ price: 19 });
  });

  it('an identical resolved price does NOT republish (dedupe); a changed one does', async () => {
    const base = 6_500_000;
    await recordTick('SOL', 'binance', 50, 1, 'USDT', base);
    expect(publishCount('SOL')).toBe(1);

    // Same price again, far later (well past any old throttle window) → still no publish.
    await recordTick('SOL', 'binance', 50, 1, 'USDT', base + 10_000);
    expect(publishCount('SOL')).toBe(1);

    // A genuine move → one more publish.
    await recordTick('SOL', 'binance', 51, 1, 'USDT', base + 20_000);
    expect(publishCount('SOL')).toBe(2);
    expect(canonical('SOL')).toMatchObject({ price: 51 });
  });

  it('dedupe is per-symbol (a second symbol publishes independently)', async () => {
    const now = 7_000_000;
    await recordTick('AAA', 'binance', 1, 0, 'USDT', now);
    await recordTick('BBB', 'binance', 2, 0, 'USDT', now);
    expect(publishCount('AAA')).toBe(1);
    expect(publishCount('BBB')).toBe(1);
  });

  it('still refreshes the canonical read cache even when the price is unchanged', async () => {
    const base = 7_500_000;
    await recordTick('XRP', 'binance', 5, 1, 'USDT', base);
    // Identical price 30s later: no new publish, but the canonical key is rewritten with
    // a fresh ts — the TTL refresh keeps the live-price read overlay warm during flat
    // stretches (lib/live-price.ts reads `price:<SYMBOL>` with a 60s TTL).
    await recordTick('XRP', 'binance', 5, 1, 'USDT', base + 30_000);
    expect(publishCount('XRP')).toBe(1);
    expect(canonical('XRP')).toMatchObject({ price: 5, ts: base + 30_000 });
  });
});

describe('sampled price history (sparklines, retrofit-20)', () => {
  const FIVE_MIN = __internals.HIST_SAMPLE_MS;

  it('appends the winning price as the first sample, then samples at most once per ≥5 min', async () => {
    const base = 8_000_000;
    // First tick → first history sample (newest at head).
    await recordTick('BTC', 'coinbase', 100, 1, 'USD', base);
    expect(lists.get('price_hist:BTC')).toEqual(['100']);

    // Another tick 1.1s later: passes the canonical throttle but NOT the 5-min
    // history gate → no new sample.
    await recordTick('BTC', 'coinbase', 101, 1, 'USD', base + 1_100);
    expect(lists.get('price_hist:BTC')).toEqual(['100']);

    // ≥5 min after the last sample → a new point is prepended (newest→oldest).
    await recordTick('BTC', 'coinbase', 102, 1, 'USD', base + FIVE_MIN + 1);
    expect(lists.get('price_hist:BTC')).toEqual(['102', '100']);
  });

  it('caps the history at 12 points (LTRIM 0..11), newest first', async () => {
    let t = 9_000_000;
    // 15 samples, each ≥5 min apart so every one passes the sample gate.
    for (let i = 0; i < 15; i++) {
      await recordTick('ETH', 'coinbase', 200 + i, 1, 'USD', t);
      t += FIVE_MIN + 1;
    }
    const hist = lists.get('price_hist:ETH')!;
    expect(hist).toHaveLength(__internals.HIST_MAX_POINTS); // 12
    expect(hist[0]).toBe('214'); // newest (last pushed) at head
    expect(hist[11]).toBe('203'); // oldest 12 kept; 200..202 trimmed off
  });

  it('history sampling is per-symbol (one symbol does not gate another)', async () => {
    const now = 10_000_000;
    await recordTick('AAA', 'coinbase', 1, 0, 'USD', now);
    await recordTick('BBB', 'coinbase', 2, 0, 'USD', now);
    expect(lists.get('price_hist:AAA')).toEqual(['1']);
    expect(lists.get('price_hist:BBB')).toEqual(['2']);
  });
});
