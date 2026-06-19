// Neonfi backend — live-price read overlay tests (retrofit-15).
//
// retrofit-15 makes every read path prefer the live `price:<SYMBOL>` cache over the
// seeded `Token.currentPrice`, falling back to currentPrice when there's no fresh tick.
// These tests seed Redis directly (retrofit-15 does NOT populate the cache — that's the
// writers' job, retrofit-16 / POST /prices/refresh) and assert the read paths reflect it:
//   - getLivePriceMap unit behaviour (fresh-only, malformed-skip, Redis-down → empty)
//   - GET /portfolios/:id totalValue        (derive.ts overlay)
//   - GET /portfolios/:id/assets value+price (assets.dto/service overlay)
//   - GET /overview totals + allocation      (overview.service overlay)
//   - fallback to seeded currentPrice when no tick exists
//
// Real DB + Redis; per-test cleanup. truncateAllUserData (helpers) now flushes `price:*`
// alongside the derived caches, so a seeded tick never bleeds into another file's
// seeded-price assertions (all files share one Redis — fileParallelism:false). Tests 379-385.

import { it, beforeAll, beforeEach, afterAll, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { getLivePriceMap, getLiveChangeMap } from '../src/lib/live-price.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock — register/login send mails we don't exercise here
// ---------------------------------------------------------------------------

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendUpgradeEmail: vi.fn().mockResolvedValue(undefined),
  sendDowngradeScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendCancellationScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendRefundConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendPlanDowngradeAppliedEmail: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_BASE = '/api/v1/auth';
const PORT_BASE = '/api/v1/portfolios';
const OVERVIEW_BASE = '/api/v1/overview';

const TEST_EMAIL = 'live-price.api@neonfi.test';
const TEST_PASSWORD = 'Test1234';

// Seeded DB prices (prisma seed): BTC 93000, ETH 3200.
let btcId: number;
let ethId: number;

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(): Promise<string> {
  await authPost('/register', { email: TEST_EMAIL, password: TEST_PASSWORD, fullName: 'Live Price' });
  const res = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  return u.id;
}

async function createManualPortfolio(userId: number, netDeposit?: number): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const p = await prisma.portfolio.create({
    data: {
      userId,
      name: 'LP',
      typeId: type.id,
      ...(netDeposit !== undefined ? { netDeposit: netDeposit.toString() } : {}),
    },
  });
  return p.id;
}

async function seedAsset(portfolioId: number, tokenId: number, balance: number): Promise<void> {
  await prisma.asset.create({ data: { portfolioId, tokenId, balance: balance.toString() } });
}

// Seed a fresh canonical tick exactly as the writers do (lib/coinbase.ts): the same
// JSON shape + 60s TTL the read overlay expects.
async function seedTick(symbol: string, price: number, change24h = 0): Promise<void> {
  await redis.set(
    `price:${symbol}`,
    JSON.stringify({ price, change24h, timestamp: Date.now() }),
    'EX',
    60,
  );
}

function portGet(portfolioId: number, cookies: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}`, {
    method: 'GET',
    headers: { Cookie: cookies },
  });
}

function assetsGet(portfolioId: number, cookies: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}/assets`, {
    method: 'GET',
    headers: { Cookie: cookies },
  });
}

function overviewGet(cookies: string): Promise<Response> {
  return app.request(OVERVIEW_BASE, { method: 'GET', headers: { Cookie: cookies } });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  btcId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } })).id;
  ethId = (await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } })).id;
});

beforeEach(async () => {
  // truncateAllUserData now flushes price:* + portfolio_pnl/analytics caches. overview:*
  // is keyed by userId (which TRUNCATE recycles), so flush it here like overview.test.
  await truncateAllUserData();
  await clearRedisAuthKeys();
  const overviewKeys = await redis.keys('overview:*');
  if (overviewKeys.length > 0) await redis.del(overviewKeys);
});

afterAll(async () => {
  // Don't leak seeded ticks into later files' seeded-price assertions.
  const keys = await redis.keys('price:*');
  if (keys.length > 0) await redis.del(keys);
});

// ---------------------------------------------------------------------------
// 379 — getLivePriceMap: only fresh, well-formed, positive-number ticks survive
// ---------------------------------------------------------------------------

it('379: getLivePriceMap returns only symbols with a fresh, valid tick (malformed/absent omitted)', async () => {
  await seedTick('AAA', 250); // valid → included
  // BBB: no key at all → omitted
  await redis.set('price:CCC', 'not-json', 'EX', 60); // malformed JSON → omitted
  await seedTick('DDD', -5); // non-positive → omitted
  await redis.set('price:EEE', JSON.stringify({ price: '250' }), 'EX', 60); // string price → omitted

  const map = await getLivePriceMap(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);

  expect(map.get('AAA')).toBe(250);
  expect(map.has('BBB')).toBe(false);
  expect(map.has('CCC')).toBe(false);
  expect(map.has('DDD')).toBe(false);
  expect(map.has('EEE')).toBe(false);
  expect(map.size).toBe(1);

  // Empty input short-circuits to an empty map (no Redis round-trip).
  expect((await getLivePriceMap([])).size).toBe(0);
});

// ---------------------------------------------------------------------------
// 380 — getLivePriceMap never throws: a Redis failure degrades to an empty map
// ---------------------------------------------------------------------------

it('380: getLivePriceMap returns an empty map (no throw) when Redis errors', async () => {
  const spy = vi.spyOn(redis, 'mget').mockRejectedValue(new Error('redis down'));
  try {
    const map = await getLivePriceMap(['BTC', 'ETH']);
    expect(map.size).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// 381 — GET /portfolios/:id totalValue reflects the live tick, not seeded currentPrice
// ---------------------------------------------------------------------------

it('381: portfolio totalValue overlays live price (BTC 1.0 + ETH 2.0 → live 108000, not seeded 99400)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 2.0);

  // Live ticks differ from seeded (BTC 93000 / ETH 3200).
  await seedTick('BTC', 100000);
  await seedTick('ETH', 4000);

  const res = await portGet(portfolioId, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { portfolio: { totalValue: number } } };
  // live: 1*100000 + 2*4000 = 108000 (seeded would be 1*93000 + 2*3200 = 99400)
  expect(json.data.portfolio.totalValue).toBeCloseTo(108000, 2);
});

// ---------------------------------------------------------------------------
// 382 — GET /portfolios/:id/assets price + value reflect the live tick
// ---------------------------------------------------------------------------

it('382: asset list price + value overlay the live tick (BTC price 100000, value 100000)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 2.0);

  await seedTick('BTC', 100000);
  await seedTick('ETH', 4000);

  const res = await assetsGet(portfolioId, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data: { assets: Array<{ symbol: string; price: number; value: number; portfolioPercentage: number }> };
  };

  const btc = json.data.assets.find((a) => a.symbol === 'BTC')!;
  const eth = json.data.assets.find((a) => a.symbol === 'ETH')!;
  expect(btc.price).toBeCloseTo(100000, 2);
  expect(btc.value).toBeCloseTo(100000, 2); // 1.0 * 100000
  expect(eth.price).toBeCloseTo(4000, 2);
  expect(eth.value).toBeCloseTo(8000, 2); // 2.0 * 4000
  // portfolioPercentage is relative to the live total (108000)
  expect(btc.portfolioPercentage).toBeCloseTo((100000 / 108000) * 100, 4);
});

// ---------------------------------------------------------------------------
// 383 — GET /overview: totals stay live, allocation uses the stored daily price
// ---------------------------------------------------------------------------
// retrofit-28 deliberately removed the per-request live-price overlay from the overview
// allocation/holdings path — the CLIENT now owns the live allocation overlay (it recomputes
// from the firehose × balance, with the stored/daily currentPrice as the fallback). So:
//   - totals.totalValue stays LIVE: it comes from computeDerived, which keeps its own
//     overlay (1×100000 + 2×4000 = 108000).
//   - allocation[].value is the stored/daily currentPrice (seed: BTC 93000, ETH 3200), NOT
//     the live tick (1×93000 = 93000; 2×3200 = 6400).
// retrofit-62: this assertion was the stale side (it asserted the old, pre-28 live allocation
// overlay). The retrofit-28 design stands — do NOT re-introduce the server-side overlay.
it('383: overview totals stay live (computeDerived); allocation uses the stored daily price', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 2.0);

  await seedTick('BTC', 100000);
  await seedTick('ETH', 4000);

  const res = await overviewGet(cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data: {
      totals: { totalValue: number };
      allocation: Array<{ symbol: string; value: number }>;
    };
  };

  // Totals overlay the live tick (computeDerived): 1*100000 + 2*4000 = 108000.
  expect(json.data.totals.totalValue).toBeCloseTo(108000, 2);
  // Allocation is the stored/daily fallback (BTC 93000, ETH 3200) — the client adds the live
  // overlay on top.
  const btcAlloc = json.data.allocation.find((a) => a.symbol === 'BTC')!;
  const ethAlloc = json.data.allocation.find((a) => a.symbol === 'ETH')!;
  expect(btcAlloc.value).toBeCloseTo(93000, 2);
  expect(ethAlloc.value).toBeCloseTo(6400, 2);
});

// ---------------------------------------------------------------------------
// 384 — no tick for a held symbol → fall back to seeded currentPrice
// ---------------------------------------------------------------------------

it('384: with no live tick, value falls back to seeded currentPrice (totalValue 99400)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 2.0);

  // No price:* ticks seeded (beforeEach flushed them).
  const res = await portGet(portfolioId, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { portfolio: { totalValue: number } } };
  // seeded: 1*93000 + 2*3200 = 99400
  expect(json.data.portfolio.totalValue).toBeCloseTo(99400, 2);
});

// ---------------------------------------------------------------------------
// 385 — partial overlay: BTC has a tick, ETH doesn't → mix live + seeded
// ---------------------------------------------------------------------------

it('385: a tick for one symbol overlays only that symbol; the other uses seeded price', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);
  await seedAsset(portfolioId, ethId, 2.0);

  await seedTick('BTC', 100000); // ETH has no tick → seeded 3200

  const res = await portGet(portfolioId, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { portfolio: { totalValue: number } } };
  // live BTC + seeded ETH: 1*100000 + 2*3200 = 106400
  expect(json.data.portfolio.totalValue).toBeCloseTo(106400, 2);
});

// ---------------------------------------------------------------------------
// retrofit-39 — 24h change overlay (getLiveChangeMap + asset DTO priceChange24h)
// ---------------------------------------------------------------------------

// 394 — getLiveChangeMap: finite changes (incl. 0 / negative) survive; everything
// else (absent, malformed, missing field, non-number) is omitted.
it('394: getLiveChangeMap keeps finite changes (incl. 0 and negative) and omits malformed/absent/non-number', async () => {
  await seedTick('AAA', 100, 5.5); // positive → included
  await seedTick('BBB', 100, 0); // zero is a real reading → included
  await seedTick('CCC', 100, -3.2); // negative → included
  // DDD: no key at all → omitted
  await redis.set('price:EEE', 'not-json', 'EX', 60); // malformed JSON → omitted
  await redis.set('price:FFF', JSON.stringify({ price: 100 }), 'EX', 60); // no change24h field → omitted
  await redis.set('price:GGG', JSON.stringify({ price: 100, change24h: '5' }), 'EX', 60); // string → omitted

  const map = await getLiveChangeMap(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG']);

  expect(map.get('AAA')).toBe(5.5);
  expect(map.get('BBB')).toBe(0);
  expect(map.get('CCC')).toBe(-3.2);
  expect(map.has('DDD')).toBe(false);
  expect(map.has('EEE')).toBe(false);
  expect(map.has('FFF')).toBe(false);
  expect(map.has('GGG')).toBe(false);
  expect(map.size).toBe(3);

  // Empty input short-circuits to an empty map (no Redis round-trip).
  expect((await getLiveChangeMap([])).size).toBe(0);
});

// 395 — asset DTO priceChange24h comes from the fresh tick; live wins over a persisted value.
it('395: GET /assets sets priceChange24h from the fresh tick (live wins over persisted Token.change24h)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);

  // A persisted (cold) value exists, but a fresh tick must take precedence.
  await prisma.token.update({ where: { symbol: 'BTC' }, data: { change24h: '1.2345' } });
  try {
    await seedTick('BTC', 100000, 4.56);

    const res = await assetsGet(portfolioId, cookies);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { assets: Array<{ symbol: string; priceChange24h: number | null }> };
    };
    const btc = json.data.assets.find((a) => a.symbol === 'BTC')!;
    expect(btc.priceChange24h).toBeCloseTo(4.56, 4); // live, not persisted 1.2345
  } finally {
    await prisma.token.update({ where: { symbol: 'BTC' }, data: { change24h: null } });
  }
});

// 396 — cold cache (no tick): priceChange24h falls back to the persisted Token.change24h.
it('396: GET /assets falls back to persisted Token.change24h when the live cache is cold', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, btcId, 1.0);

  // No price:* tick (beforeEach flushed). Persisted CMC value present (negative is valid).
  await prisma.token.update({ where: { symbol: 'BTC' }, data: { change24h: '-2.5' } });
  try {
    const res = await assetsGet(portfolioId, cookies);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { assets: Array<{ symbol: string; priceChange24h: number | null }> };
    };
    const btc = json.data.assets.find((a) => a.symbol === 'BTC')!;
    expect(btc.priceChange24h).toBeCloseTo(-2.5, 4);
  } finally {
    await prisma.token.update({ where: { symbol: 'BTC' }, data: { change24h: null } });
  }
});

// 397 — neither a live tick nor a persisted value → priceChange24h is null (true "—").
it('397: GET /assets priceChange24h is null when neither a tick nor a persisted value exists', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  const portfolioId = await createManualPortfolio(userId);
  await seedAsset(portfolioId, ethId, 2.0); // ETH: no tick, Token.change24h null (column default)

  const res = await assetsGet(portfolioId, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data: { assets: Array<{ symbol: string; priceChange24h: number | null }> };
  };
  const eth = json.data.assets.find((a) => a.symbol === 'ETH')!;
  expect(eth.priceChange24h).toBeNull();
});
