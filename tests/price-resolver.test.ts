// Neonfi backend — canonical price resolver tests (retrofit-16).
//
// Redis is replaced with an in-memory store (vi.hoisted so the factory can close
// over it) — recordTick's per-exchange writes land in `store`, and canonical
// publishes are captured in `published`. `now` is injected for deterministic
// dedupe/freshness behavior.

import { it, expect, describe, beforeEach, vi } from 'vitest';

const { store, lists, published, ltrimCalls, expireCalls } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  // retrofit-20: list-typed keys (price_hist:*) live in their own store so the string
  // KV ops (set/get/mget) and the list ops (lpush/ltrim/lrange) don't collide.
  lists: new Map<string, string[]>(),
  published: [] as Array<{ channel: string; message: string }>,
  // retrofit-43: record LTRIM/EXPIRE args so the cap + TTL can be asserted directly.
  ltrimCalls: [] as Array<{ key: string; start: number; stop: number }>,
  expireCalls: [] as Array<{ key: string; ttl: number }>,
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
      ltrimCalls.push({ key, start, stop });
      const cur = lists.get(key) ?? [];
      lists.set(key, cur.slice(start, resolveStop(cur.length, stop) + 1));
      return 'OK';
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const cur = lists.get(key) ?? [];
      return cur.slice(start, resolveStop(cur.length, stop) + 1);
    }),
    expire: vi.fn(async (key: string, ttl: number) => {
      expireCalls.push({ key, ttl });
      return 1;
    }),
    // recordTick/resolveCanonical now batch their Redis ops via pipeline() (perf #6-8). The
    // pipeline mirrors the standalone-command side effects into the same in-memory stores so
    // the existing assertions (canonical store, published, ltrimCalls, expireCalls) still hold.
    pipeline() {
      const results: Array<[null, unknown]> = [];
      const api: Record<string, unknown> = {};
      api.set = (key: string, val: string) => {
        store.set(key, val);
        results.push([null, 'OK']);
        return api;
      };
      api.mget = (...keys: string[]) => {
        results.push([null, keys.map((k) => store.get(k) ?? null)]);
        return api;
      };
      api.publish = (channel: string, message: string) => {
        published.push({ channel, message });
        results.push([null, 1]);
        return api;
      };
      api.lpush = (key: string, ...vals: string[]) => {
        const cur = lists.get(key) ?? [];
        cur.unshift(...[...vals].reverse());
        lists.set(key, cur);
        results.push([null, cur.length]);
        return api;
      };
      api.ltrim = (key: string, start: number, stop: number) => {
        ltrimCalls.push({ key, start, stop });
        const cur = lists.get(key) ?? [];
        lists.set(key, cur.slice(start, resolveStop(cur.length, stop) + 1));
        results.push([null, 'OK']);
        return api;
      };
      api.expire = (key: string, ttl: number) => {
        expireCalls.push({ key, ttl });
        results.push([null, 1]);
        return api;
      };
      api.exec = async () => results;
      return api;
    },
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
  ltrimCalls.length = 0;
  expireCalls.length = 0;
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

  it('binance beats kraken when both are fresh (broadest/fastest source first, retrofit-35)', async () => {
    const now = 2_000_000;
    store.set('price:BTC:kraken', JSON.stringify({ price: 101, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('BTC', 'binance', 100, 2, 'USDT', now);

    // retrofit-35: binance (priority 0, broadest real-time coverage) now outranks kraken (6).
    expect(canonical('BTC')).toMatchObject({ price: 100, source: 'binance' });
  });

  it('binance beats coinbase when both are fresh (retrofit-35 priority)', async () => {
    const now = 2_500_000;
    store.set('price:BTC:coinbase', JSON.stringify({ price: 101, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('BTC', 'binance', 100, 2, 'USDT', now);

    expect(canonical('BTC')).toMatchObject({ price: 100, source: 'binance' });
  });

  it('coinbase beats kraken when both are fresh (priority, retrofit-35)', async () => {
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

  it('kraken is used when it is the sole fresh source (others stale)', async () => {
    const now = 5_000_000;
    // binance stale → ignored; kraken fresh → wins despite lowest priority
    store.set('price:SOL:binance', JSON.stringify({ price: 150, change24h: 1, quote: 'USDT', ts: now - 30_000 }));

    await recordTick('SOL', 'kraken', 151, 2, 'USD', now);

    expect(canonical('SOL')).toMatchObject({ price: 151, source: 'kraken' });
  });

  it('full priority order with all three fresh → binance wins (retrofit-35); coinbase/kraken never used', async () => {
    const now = 5_500_000;
    store.set('price:SOL:coinbase', JSON.stringify({ price: 150, change24h: 1, quote: 'USD', ts: now }));
    store.set('price:SOL:kraken', JSON.stringify({ price: 151, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('SOL', 'binance', 152, 2, 'USDT', now);

    expect(canonical('SOL')).toMatchObject({ price: 152, source: 'binance' });
  });
});

describe('kraken trade/bbo merge (retrofit-35)', () => {
  it('kraken trade + kraken_bbo both fresh → newer ts wins; source reflects which', async () => {
    const now = 11_000_000;
    // bbo is newer than the trade → bbo-mid surfaces (keeps a thin pair moving).
    store.set('price:LINK:kraken', JSON.stringify({ price: 20, change24h: 1, quote: 'USD', ts: now - 4_000 }));
    await recordTick('LINK', 'kraken_bbo', 21, 1, 'USD', now);
    expect(canonical('LINK')).toMatchObject({ price: 21, source: 'kraken_bbo' });
  });

  it('equal ts → the trade (kraken) wins (a real execution beats a mid)', async () => {
    const now = 11_500_000;
    store.set('price:LINK:kraken_bbo', JSON.stringify({ price: 21, change24h: 1, quote: 'USD', ts: now }));
    await recordTick('LINK', 'kraken', 20, 1, 'USD', now);
    expect(canonical('LINK')).toMatchObject({ price: 20, source: 'kraken' });
  });

  it('the trade wins when it is the more current of the two', async () => {
    const now = 12_000_000;
    // bbo is older than the live trade → trade wins.
    store.set('price:LINK:kraken_bbo', JSON.stringify({ price: 99, change24h: 1, quote: 'USD', ts: now - 6_000 }));
    await recordTick('LINK', 'kraken', 20, 1, 'USD', now);
    expect(canonical('LINK')).toMatchObject({ price: 20, source: 'kraken' });
  });

  it('only kraken_bbo fresh → bbo-mid is used and labelled kraken_bbo', async () => {
    const now = 12_500_000;
    await recordTick('LINK', 'kraken_bbo', 22, 1, 'USD', now);
    expect(canonical('LINK')).toMatchObject({ price: 22, source: 'kraken_bbo' });
  });
});

describe('cross-source outlier guard (retrofit-35)', () => {
  it('a single fresh source is accepted as-is (no cross-check possible)', async () => {
    const now = 13_000_000;
    await recordTick('PEPE', 'gate', 0.0000123, 1, 'USDT', now);
    expect(canonical('PEPE')).toMatchObject({ price: 0.0000123, source: 'gate' });
  });

  it('an absurd source (≥RATIO× the median) is dropped and a sane source wins', async () => {
    const now = 13_500_000;
    // binance + coinbase agree (~65000); kraken is 100× off (a collision/bad print) → dropped.
    store.set('price:BTC:coinbase', JSON.stringify({ price: 65010, change24h: 1, quote: 'USD', ts: now }));
    store.set('price:BTC:kraken', JSON.stringify({ price: 6_500_000, change24h: 1, quote: 'USD', ts: now }));

    await recordTick('BTC', 'binance', 65000, 2, 'USDT', now);

    // kraken dropped as an outlier; binance (priority 0) wins among the sane cluster.
    expect(canonical('BTC')).toMatchObject({ price: 65000, source: 'binance' });
  });

  it('two sources disagreeing beyond the ratio keep the higher-priority one (no majority)', async () => {
    const now = 14_000_000;
    // coinbase (priority 1) vs gate (priority 4) disagree 1000× — no majority to trust.
    store.set('price:FOO:gate', JSON.stringify({ price: 100_000, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('FOO', 'coinbase', 100, 2, 'USD', now);

    // No consensus → keep the higher-priority source (coinbase) rather than the median survivor.
    expect(canonical('FOO')).toMatchObject({ price: 100, source: 'coinbase' });
  });
});

describe('long-tail sources (gate/kucoin, retrofit-36)', () => {
  it('a symbol fresh ONLY on gate resolves from gate', async () => {
    const now = 15_000_000;
    await recordTick('PEPE', 'gate', 0.0000123, 1, 'USDT', now);
    expect(canonical('PEPE')).toMatchObject({ price: 0.0000123, source: 'gate' });
  });

  it('a symbol fresh ONLY on kucoin resolves from kucoin', async () => {
    const now = 15_500_000;
    await recordTick('SHIB', 'kucoin', 0.00002, 1, 'USDT', now);
    expect(canonical('SHIB')).toMatchObject({ price: 0.00002, source: 'kucoin' });
  });

  it('binance outranks gate/kucoin when all are fresh (priority)', async () => {
    const now = 16_000_000;
    store.set('price:DOGE:gate', JSON.stringify({ price: 0.16, change24h: 1, quote: 'USDT', ts: now }));
    store.set('price:DOGE:kucoin', JSON.stringify({ price: 0.161, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('DOGE', 'binance', 0.162, 2, 'USDT', now);

    expect(canonical('DOGE')).toMatchObject({ price: 0.162, source: 'binance' });
  });

  it('gate outranks kucoin when both are fresh (gate:4 < kucoin:5)', async () => {
    const now = 16_500_000;
    store.set('price:DOGE:kucoin', JSON.stringify({ price: 0.161, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('DOGE', 'gate', 0.160, 2, 'USDT', now);

    expect(canonical('DOGE')).toMatchObject({ price: 0.160, source: 'gate' });
  });
});

describe('depth sources (okx/bybit, retrofit-37)', () => {
  it('a symbol fresh ONLY on okx resolves from okx', async () => {
    const now = 17_000_000;
    await recordTick('AVAX', 'okx', 40.5, 1, 'USDT', now);
    expect(canonical('AVAX')).toMatchObject({ price: 40.5, source: 'okx' });
  });

  it('a symbol fresh ONLY on bybit resolves from bybit', async () => {
    const now = 17_500_000;
    await recordTick('AVAX', 'bybit', 41.0, 1, 'USDT', now);
    expect(canonical('AVAX')).toMatchObject({ price: 41.0, source: 'bybit' });
  });

  it('binance/coinbase win over okx/bybit when fresh (priority 0/1 < 2/3)', async () => {
    const now = 18_000_000;
    store.set('price:AVAX:okx', JSON.stringify({ price: 40.5, change24h: 1, quote: 'USDT', ts: now }));
    store.set('price:AVAX:bybit', JSON.stringify({ price: 40.6, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('AVAX', 'coinbase', 40.7, 2, 'USD', now);

    expect(canonical('AVAX')).toMatchObject({ price: 40.7, source: 'coinbase' });
  });

  it('okx outranks bybit when both are fresh (okx:2 < bybit:3)', async () => {
    const now = 18_500_000;
    store.set('price:AVAX:bybit', JSON.stringify({ price: 40.6, change24h: 1, quote: 'USDT', ts: now }));

    await recordTick('AVAX', 'okx', 40.5, 2, 'USDT', now);

    expect(canonical('AVAX')).toMatchObject({ price: 40.5, source: 'okx' });
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

describe('sampled intraday price history (retrofit-20/43)', () => {
  const SAMPLE_MS = __internals.HIST_SAMPLE_MS; // 3 min (retrofit-43)

  it('appends "<ts>|<price>" as the first sample, then samples at most once per ≥SAMPLE_MS', async () => {
    const base = 8_000_000;
    // First tick → first history sample (newest at head), timestamped.
    await recordTick('BTC', 'coinbase', 100, 1, 'USD', base);
    expect(lists.get('price_hist:BTC')).toEqual([`${base}|100`]);

    // Another tick 1.1s later: passes the canonical throttle but NOT the sample
    // gate → no new sample.
    await recordTick('BTC', 'coinbase', 101, 1, 'USD', base + 1_100);
    expect(lists.get('price_hist:BTC')).toEqual([`${base}|100`]);

    // ≥SAMPLE_MS after the last sample → a new point is prepended (newest→oldest),
    // each carrying its own timestamp so a skipped sample is not drawn evenly-spaced.
    const t2 = base + SAMPLE_MS + 1;
    await recordTick('BTC', 'coinbase', 102, 1, 'USD', t2);
    expect(lists.get('price_hist:BTC')).toEqual([`${t2}|102`, `${base}|100`]);
  });

  it('caps the history at HIST_MAX_POINTS (LTRIM 0..MAX-1) + refreshes the 24h TTL', async () => {
    const MAX = __internals.HIST_MAX_POINTS; // 480
    let t = 9_000_000;
    // MAX + 3 samples, each ≥SAMPLE_MS apart so every one passes the sample gate.
    for (let i = 0; i < MAX + 3; i++) {
      await recordTick('ETH', 'coinbase', 200 + i, 1, 'USD', t);
      t += SAMPLE_MS + 1;
    }
    const hist = lists.get('price_hist:ETH')!;
    expect(hist).toHaveLength(MAX); // capped — never exceeds MAX
    expect(hist[0]).toBe(`${t - (SAMPLE_MS + 1)}|${200 + MAX + 2}`); // newest (last pushed) at head

    // LTRIM always asked for 0..MAX-1, and EXPIRE always set the 24h TTL.
    const ethTrims = ltrimCalls.filter((c) => c.key === 'price_hist:ETH');
    expect(ethTrims.length).toBeGreaterThan(0);
    expect(ethTrims.every((c) => c.start === 0 && c.stop === MAX - 1)).toBe(true);
    const ethExpires = expireCalls.filter((c) => c.key === 'price_hist:ETH');
    expect(ethExpires.length).toBeGreaterThan(0);
    expect(ethExpires.every((c) => c.ttl === __internals.HIST_TTL_S)).toBe(true);
  });

  it('history sampling is per-symbol (one symbol does not gate another)', async () => {
    const now = 10_000_000;
    await recordTick('AAA', 'coinbase', 1, 0, 'USD', now);
    await recordTick('BBB', 'coinbase', 2, 0, 'USD', now);
    expect(lists.get('price_hist:AAA')).toEqual([`${now}|1`]);
    expect(lists.get('price_hist:BBB')).toEqual([`${now}|2`]);
  });
});
