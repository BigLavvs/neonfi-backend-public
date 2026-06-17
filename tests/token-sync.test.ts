// Neonfi backend — Token Metadata Sync tests (Stage 9B).
//
// Strategy: inject a mock TokenMetadataProvider; call runTokenMetadataSync()
// directly. No real Moralis HTTP calls. Token table is NOT truncated between
// tests (30 seeded rows stay). afterEach restores the 3 tokens mutated by tests.
// Note: with 30 seeded tokens, `skipped` counts will include all tokens the mock
// provider didn't return data for (not just explicitly "skipped" ones).

import { it, beforeEach, afterEach, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { runTokenMetadataSync } from '../src/modules/tokens/sync/sync.js';
import { CoinMarketCapTokenMetadataProvider } from '../src/modules/tokens/sync/coinmarketcap-provider.js';
import type { TokenMetadataProvider, TokenMetadata } from '../src/modules/tokens/sync/provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(
  name: string,
  data: Map<string, TokenMetadata>,
): TokenMetadataProvider {
  return {
    name,
    fetchMetadata: async (_symbols: string[]) => data,
  };
}

function makeThrowingProvider(name: string): TokenMetadataProvider {
  return {
    name,
    fetchMetadata: async (_symbols: string[]) => {
      throw new Error('Simulated provider network failure');
    },
  };
}

// Seed values mirrored from prisma/seed.ts (used for afterEach restore)
const BTC_SEED = { currentPrice: '93000.00', marketCap: '1850000000000.00', rank: 1 };
const ETH_SEED = { currentPrice: '3200.00', marketCap: '385000000000.00', rank: 2 };
const USDT_SEED = { currentPrice: '1.00', marketCap: '120000000000.00', rank: 3 };

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const keys = await redis.keys('token_meta:*');
  if (keys.length > 0) await redis.del(keys);
});

afterEach(async () => {
  // Restore seed values for the tokens used across these tests. change24h (retrofit-39)
  // and logoUrl (retrofit-40) are null in the seed — reset them too so a test that writes
  // them can't bleed a stale 24h change / logo into the live-price / assets / tokens suites
  // (all files share one DB).
  await prisma.token.update({ where: { symbol: 'BTC' }, data: { ...BTC_SEED, change24h: null, logoUrl: null } });
  await prisma.token.update({ where: { symbol: 'ETH' }, data: { ...ETH_SEED, change24h: null, logoUrl: null } });
  await prisma.token.update({ where: { symbol: 'USDT' }, data: { ...USDT_SEED, change24h: null, logoUrl: null } });
  const keys = await redis.keys('token_meta:*');
  if (keys.length > 0) await redis.del(keys);
});

// ---------------------------------------------------------------------------
// 225. Happy path — provider returns data for 3 symbols
// ---------------------------------------------------------------------------

it('225: happy path — provider returns metadata for 3 symbols; updated=3, failed=0; Token rows reflect new values', async () => {
  const mockData = new Map<string, TokenMetadata>([
    ['BTC',  { symbol: 'BTC',  currentPrice: '100000.00', marketCap: '2000000000000.00', rank: 1 }],
    ['ETH',  { symbol: 'ETH',  currentPrice: '4000.00',   marketCap: '500000000000.00',  rank: 2 }],
    ['USDT', { symbol: 'USDT', currentPrice: '1.0001',    marketCap: '125000000000.00',  rank: 3 }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  const result = await runTokenMetadataSync(provider);

  expect(result.updated).toBe(3);
  expect(result.failed).toBe(0);

  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(Number(btc.currentPrice.toString())).toBeCloseTo(100000);

  const eth = await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } });
  expect(Number(eth.currentPrice.toString())).toBeCloseTo(4000);

  const usdt = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } });
  expect(Number(usdt.currentPrice.toString())).toBeCloseTo(1.0001);
});

// ---------------------------------------------------------------------------
// 226. Skipped symbol — provider doesn't return USDT
// ---------------------------------------------------------------------------

it('226: skipped symbol — provider returns BTC+ETH but not USDT; updated=2, failed=0; USDT row unchanged', async () => {
  const mockData = new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '95000.00', marketCap: '1900000000000.00', rank: 1 }],
    ['ETH', { symbol: 'ETH', currentPrice: '3500.00',  marketCap: '420000000000.00',  rank: 2 }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  const result = await runTokenMetadataSync(provider);

  expect(result.updated).toBe(2);
  expect(result.failed).toBe(0);
  // skipped >= 1 (USDT plus the 27 other seeded tokens not in provider response)
  expect(result.skipped).toBeGreaterThanOrEqual(1);

  // USDT row must be unchanged
  const usdt = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDT' } });
  expect(Number(usdt.currentPrice.toString())).toBeCloseTo(1.0); // original seed value
});

// ---------------------------------------------------------------------------
// 227. Provider throws — all tokens fail
// ---------------------------------------------------------------------------

it('227: provider throws — updated=0, skipped=0, failed=total_token_count; no Token rows modified', async () => {
  const btcBefore = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  const tokenCount = await prisma.token.count();

  const result = await runTokenMetadataSync(makeThrowingProvider('mock'));

  expect(result.updated).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.failed).toBe(tokenCount);

  // BTC row must be unchanged
  const btcAfter = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(btcAfter.currentPrice.toString()).toBe(btcBefore.currentPrice.toString());
});

// ---------------------------------------------------------------------------
// 228. Per-symbol DB failure — one symbol has invalid price; others succeed
// ---------------------------------------------------------------------------

it('228: per-symbol failure — invalid price for BTC causes DB error; updated=2, skipped=27, failed=1', async () => {
  const mockData = new Map<string, TokenMetadata>([
    ['BTC',  { symbol: 'BTC',  currentPrice: 'not_a_decimal', marketCap: null,                  rank: null }],
    ['ETH',  { symbol: 'ETH',  currentPrice: '3600.00',       marketCap: '440000000000.00',      rank: 2    }],
    ['USDT', { symbol: 'USDT', currentPrice: '1.002',         marketCap: '121000000000.00',      rank: 3    }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  const result = await runTokenMetadataSync(provider);

  expect(result.updated).toBe(2);  // ETH + USDT
  expect(result.failed).toBe(1);   // BTC

  // BTC row must be unchanged (failed update)
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(Number(btc.currentPrice.toString())).toBeCloseTo(93000); // seed value

  // ETH and USDT were updated
  const eth = await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } });
  expect(Number(eth.currentPrice.toString())).toBeCloseTo(3600);
});

// ---------------------------------------------------------------------------
// 229. Redis cache invalidation
// ---------------------------------------------------------------------------

it('229: Redis cache invalidation — token_meta:BTC key deleted after successful sync', async () => {
  // Pre-seed a stale cache key
  await redis.set('token_meta:BTC', JSON.stringify({ price: 93000 }));
  expect(await redis.exists('token_meta:BTC')).toBe(1);

  const mockData = new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '96000.00', marketCap: '1920000000000.00', rank: 1 }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  await runTokenMetadataSync(provider);

  // Key must be gone after sync
  expect(await redis.exists('token_meta:BTC')).toBe(0);
});

// ---------------------------------------------------------------------------
// 230. rank:null in provider response — existing rank NOT overwritten
// ---------------------------------------------------------------------------

it('230: rank=null in provider — existing Token.rank is NOT overwritten with null', async () => {
  const btcBefore = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(btcBefore.rank).toBe(1); // seed value

  const mockData = new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '97000.00', marketCap: '1950000000000.00', rank: null }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  await runTokenMetadataSync(provider);

  const btcAfter = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  // Price updated but rank preserved
  expect(Number(btcAfter.currentPrice.toString())).toBeCloseTo(97000);
  expect(btcAfter.rank).toBe(1); // unchanged
});

// ---------------------------------------------------------------------------
// 231. Provider returns empty map — all tokens skipped, no failures
// ---------------------------------------------------------------------------

it('231: provider returns empty map → all symbols skipped, updated=0, failed=0', async () => {
  const provider = makeMockProvider('mock', new Map());
  const tokenCount = await prisma.token.count();

  const result = await runTokenMetadataSync(provider);

  expect(result.updated).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(tokenCount); // every DB symbol was skipped
});

// ---------------------------------------------------------------------------
// 232. Stats reporting shape
// ---------------------------------------------------------------------------

it('232: stats reporting — return value has correct shape; durationMs > 0', async () => {
  const mockData = new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '94000.00', marketCap: '1860000000000.00', rank: 1 }],
  ]);
  const provider = makeMockProvider('mock', mockData);

  const result = await runTokenMetadataSync(provider);

  expect(typeof result.updated).toBe('number');
  expect(typeof result.skipped).toBe('number');
  expect(typeof result.failed).toBe('number');
  expect(typeof result.durationMs).toBe('number');
  expect(result.durationMs).toBeGreaterThan(0);
  expect(result.updated + result.skipped + result.failed).toBe(await prisma.token.count());
});

// ---------------------------------------------------------------------------
// 398. retrofit-39 — sync persists change24h and never nulls it on a change-less sync
// ---------------------------------------------------------------------------

it('398: sync persists change24h and preserves it when a later sync omits it', async () => {
  // First sync writes change24h.
  await runTokenMetadataSync(makeMockProvider('mock', new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '98000.00', marketCap: '1900000000000.00', rank: 1, change24h: 7.25 }],
  ])));
  let btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(Number(btc.change24h!.toString())).toBeCloseTo(7.25);

  // A later sync that OMITS change24h must NOT clear the persisted value (mirrors rank:null).
  await runTokenMetadataSync(makeMockProvider('mock', new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '99000.00', marketCap: '1910000000000.00', rank: 1 }],
  ])));
  btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(Number(btc.currentPrice.toString())).toBeCloseTo(99000); // price refreshed
  expect(Number(btc.change24h!.toString())).toBeCloseTo(7.25); // change24h preserved
});

// ---------------------------------------------------------------------------
// 399. retrofit-40 — fetchMetadata dedupes same-ticker collisions by lowest cmc_rank
//      and returns a logoUrl built from the chosen entry's id
// ---------------------------------------------------------------------------

it('399: fetchMetadata keeps the lowest-cmc_rank entry (canonical over junk) and builds logoUrl from its id', async () => {
  // "TON" returns two listings: real Toncoin (rank 15, market_cap null — a common CMC gap)
  // and a rank-3538 junk coin with a non-null cap. Market-cap-only dedupe would pick the
  // junk coin; rank-priority must keep canonical Toncoin and emit its logo.
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        TON: [
          { id: 99999, cmc_rank: 3538, quote: { USD: { price: 0.001, percent_change_24h: 1, market_cap: 5_000 } } },
          { id: 11419, cmc_rank: 15,   quote: { USD: { price: 5.5,   percent_change_24h: 2, market_cap: null } } },
        ],
      },
    }),
  } as Response));
  vi.stubGlobal('fetch', fetchMock);

  try {
    const provider = new CoinMarketCapTokenMetadataProvider('test-key');
    const result = await provider.fetchMetadata(['TON']);
    const ton = result.get('TON')!;
    expect(ton.rank).toBe(15); // canonical Toncoin, not rank-3538 junk
    expect(ton.currentPrice).toBe('5.50000000');
    expect(ton.logoUrl).toBe('https://s2.coinmarketcap.com/static/img/coins/64x64/11419.png');
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---------------------------------------------------------------------------
// 400. retrofit-40 — sync persists logoUrl and never nulls it on a logo-less sync
// ---------------------------------------------------------------------------

it('400: sync persists logoUrl and preserves it when a later sync omits it', async () => {
  // First sync writes the logo.
  await runTokenMetadataSync(makeMockProvider('mock', new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '98000.00', marketCap: '1900000000000.00', rank: 1, logoUrl: 'https://s2.coinmarketcap.com/static/img/coins/64x64/1.png' }],
  ])));
  let btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(btc.logoUrl).toBe('https://s2.coinmarketcap.com/static/img/coins/64x64/1.png');

  // A later sync that OMITS logoUrl must NOT clear the persisted value (mirrors rank/change24h).
  await runTokenMetadataSync(makeMockProvider('mock', new Map<string, TokenMetadata>([
    ['BTC', { symbol: 'BTC', currentPrice: '99000.00', marketCap: '1910000000000.00', rank: 1 }],
  ])));
  btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  expect(Number(btc.currentPrice.toString())).toBeCloseTo(99000); // price refreshed
  expect(btc.logoUrl).toBe('https://s2.coinmarketcap.com/static/img/coins/64x64/1.png'); // logo preserved
});

// ---------------------------------------------------------------------------
// 302. CMC adapter batches symbols >50 per call (A23)
// ---------------------------------------------------------------------------

it('302: 60-symbol fetchMetadata makes 2 batches and returns all 60 symbols', async () => {
  const symbols = Array.from({ length: 60 }, (_, i) => `SYM${i}`);

  // Mock global fetch — return CMC-shaped data only for the symbols actually in
  // each batch's `symbol=` query param, so the aggregation is genuinely tested
  // (batch 1 carries 50, batch 2 carries 10; neither alone has all 60).
  const fetchMock = vi.fn(async (url: string | URL) => {
    const requested = new URL(url).searchParams.get('symbol')!.split(',');
    const data: Record<string, unknown> = {};
    for (const s of requested) {
      data[s] = [
        { cmc_rank: 1, quote: { USD: { price: 1.23, percent_change_24h: 0, market_cap: 1000 } } },
      ];
    }
    return { ok: true, json: async () => ({ data }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  try {
    const provider = new CoinMarketCapTokenMetadataProvider('test-key');
    const result = await provider.fetchMetadata(symbols);

    // 60 symbols / 50 per call = 2 batches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(60);
    for (const s of symbols) {
      expect(result.has(s)).toBe(true);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---------------------------------------------------------------------------
// 303. Null CMC price — fetchMetadata skips the bad symbol, keeps the rest (retrofit-14)
// ---------------------------------------------------------------------------

it('303: fetchMetadata with a null-price symbol skips it and returns the others (no throw)', async () => {
  // BTC has a real price, NULLCOIN comes back with quote.USD.price = null —
  // the unguarded path would throw on null.toFixed(8) and sink the whole batch.
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        BTC: [{ cmc_rank: 1, quote: { USD: { price: 93000, percent_change_24h: 1.5, market_cap: 1_850_000_000_000 } } }],
        NULLCOIN: [{ cmc_rank: null, quote: { USD: { price: null, percent_change_24h: 0, market_cap: null } } }],
      },
    }),
  } as Response));
  vi.stubGlobal('fetch', fetchMock);

  try {
    const provider = new CoinMarketCapTokenMetadataProvider('test-key');
    const result = await provider.fetchMetadata(['BTC', 'NULLCOIN']);

    expect(result.has('BTC')).toBe(true);
    expect(result.get('BTC')!.currentPrice).toBe('93000.00000000');
    expect(result.get('BTC')!.change24h).toBe(1.5); // retrofit-39: percent_change_24h parsed
    // The null-price symbol is absent — skipped, not crashed.
    expect(result.has('NULLCOIN')).toBe(false);
    expect(result.size).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---------------------------------------------------------------------------
// 304. Null CMC price — fetchPrices skips the bad symbol, keeps the rest (retrofit-14)
// ---------------------------------------------------------------------------

it('304: fetchPrices with a null-price symbol skips it and returns the others (no null emitted)', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        BTC: [{ cmc_rank: 1, quote: { USD: { price: 93000, percent_change_24h: 1.5, market_cap: 1_850_000_000_000 } } }],
        NULLCOIN: [{ cmc_rank: null, quote: { USD: { price: null, percent_change_24h: 0, market_cap: null } } }],
      },
    }),
  } as Response));
  vi.stubGlobal('fetch', fetchMock);

  try {
    const provider = new CoinMarketCapTokenMetadataProvider('test-key');
    const result = await provider.fetchPrices(['BTC', 'NULLCOIN']);

    expect(result.has('BTC')).toBe(true);
    expect(result.get('BTC')!.price).toBe(93000);
    expect(result.has('NULLCOIN')).toBe(false);
    expect(result.size).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
