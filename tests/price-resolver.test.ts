// Neonfi backend — canonical price resolver tests (retrofit-16).
//
// Redis is replaced with an in-memory store (vi.hoisted so the factory can close
// over it) — recordTick's per-exchange writes land in `store`, and canonical
// publishes are captured in `published`. `now` is injected for deterministic
// throttle/freshness behavior.

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

  it('within the true-USD tier, the freshest tick wins (coinbase over older kraken)', async () => {
    const now = 3_000_000;
    store.set('price:ETH:kraken', JSON.stringify({ price: 200, change24h: 1, quote: 'USD', ts: now - 5_000 }));

    await recordTick('ETH', 'coinbase', 201, 2, 'USD', now);

    expect(canonical('ETH')).toMatchObject({ price: 201, source: 'coinbase' });
  });

  it('stale true-USD entry is ignored; a fresher same-tier entry wins', async () => {
    const now = 4_000_000;
    // coinbase tick is 20s old → outside the 15s staleness window → ignored
    store.set('price:ETH:coinbase', JSON.stringify({ price: 999, change24h: 0, quote: 'USD', ts: now - 20_000 }));

    await recordTick('ETH', 'kraken', 202, 1, 'USD', now);

    expect(canonical('ETH')).toMatchObject({ price: 202, source: 'kraken' });
  });

  it('binance is used only as a fallback when no fresh true-USD source exists', async () => {
    const now = 5_000_000;
    // kraken stale → ignored; binance fresh → wins despite lower tier
    store.set('price:SOL:kraken', JSON.stringify({ price: 150, change24h: 1, quote: 'USD', ts: now - 30_000 }));

    await recordTick('SOL', 'binance', 151, 2, 'USDT', now);

    expect(canonical('SOL')).toMatchObject({ price: 151, source: 'binance' });
  });
});

describe('throttle', () => {
  const THROTTLE = __internals.THROTTLE_MS;

  it('rapid recordTick calls collapse to ≤1 canonical write per throttle window/symbol', async () => {
    const base = 6_000_000;
    // 10 ticks packed inside a single throttle window (spacing < THROTTLE_MS), driven
    // off the constant so this holds at any cadence (e.g. 1000ms or 100ms).
    const step = Math.max(1, Math.floor(THROTTLE / 10));
    for (let i = 0; i < 10; i++) {
      await recordTick('SOL', 'binance', 10 + i, 1, 'USDT', base + i * step);
    }
    expect(publishCount('SOL')).toBe(1);

    // crossing the throttle boundary allows one more canonical write
    await recordTick('SOL', 'binance', 99, 1, 'USDT', base + THROTTLE + 100);
    expect(publishCount('SOL')).toBe(2);
    expect(canonical('SOL')).toMatchObject({ price: 99 });
  });

  it('throttle is per-symbol (a second symbol is not blocked by the first)', async () => {
    const now = 7_000_000;
    await recordTick('AAA', 'binance', 1, 0, 'USDT', now);
    await recordTick('BBB', 'binance', 2, 0, 'USDT', now);
    expect(publishCount('AAA')).toBe(1);
    expect(publishCount('BBB')).toBe(1);
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
