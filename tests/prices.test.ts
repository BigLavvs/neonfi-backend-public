// Neonfi backend — Prices module integration tests (Stage 10A).
//
// Strategy: real DB + Redis, per-test cleanup of rate_limit keys.
// CMC adapter is vi.mocked so no real HTTP calls.

import { it, beforeEach, afterEach, beforeAll, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';
import { portfolioDerivedCacheKeys } from '../src/lib/portfolio-cache-keys.js';
import { getPriceHistory } from '../src/modules/prices/prices.service.js';
import { historyQuerySchema } from '../src/modules/prices/prices.schemas.js';
import type { CoinMarketCapTokenMetadataProvider } from '../src/modules/tokens/sync/coinmarketcap-provider.js';

// ---------------------------------------------------------------------------
// Email mock
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
// CMC provider mock — hoisted so it's available in vi.mock factory
// ---------------------------------------------------------------------------

const { mockFetchPrices } = vi.hoisted(() => ({
  mockFetchPrices: vi.fn(),
}));

vi.mock('../src/modules/tokens/sync/coinmarketcap-provider.js', () => {
  const mockClass = vi.fn().mockImplementation(() => ({
    name: 'coinmarketcap',
    fetchMetadata: vi.fn().mockResolvedValue(new Map()),
    fetchPrices: mockFetchPrices,
  }));
  return { CoinMarketCapTokenMetadataProvider: mockClass };
});

// Inject the mock provider before tests run so getCmcProvider() returns the mock
beforeAll(async () => {
  const { _setCmcProvider } = await import('../src/modules/prices/prices.service.js');
  const { CoinMarketCapTokenMetadataProvider } = await import(
    '../src/modules/tokens/sync/coinmarketcap-provider.js'
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setCmcProvider(new CoinMarketCapTokenMetadataProvider('') as any);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_BASE = '/api/v1/auth';
const PRICES_BASE = '/api/v1/prices';
const TEST_EMAIL = 'prices.integration@neonfi.test';
const TEST_EMAIL_PRO = 'prices.pro.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Prices Integration';

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(email = TEST_EMAIL): Promise<string> {
  await authPost('/register', { email, password: TEST_PASSWORD, fullName: TEST_FULL_NAME });
  const res = await authPost('/login', { email, password: TEST_PASSWORD });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function createFreeSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: null,
    },
  });
}

async function createProSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });
}

beforeEach(async () => {
  await truncateAllUserData();
  mockFetchPrices.mockReset();
  await clearRedisAuthKeys();
  // Clear rate limit keys
  const rlKeys = await redis.keys('refresh_rate:*');
  if (rlKeys.length) await redis.del(rlKeys);
  // Clear price cache keys
  const priceKeys = await redis.keys('price:*');
  if (priceKeys.length) await redis.del(priceKeys);
  // retrofit-43: price_hist:* keys don't match the price:* glob (different prefix) — clear them
  // separately so an intraday history list can't bleed across tests.
  const histKeys = await redis.keys('price_hist:*');
  if (histKeys.length) await redis.del(histKeys);
});

afterEach(async () => {
  await truncateAllUserData();
});

// ---------------------------------------------------------------------------
// 239. Happy path — free user, symbols=[BTC], CMC returns price
// ---------------------------------------------------------------------------

it('239: POST /prices/refresh free user with symbols=[BTC] (CMC mock) → 200 source=live; Redis key set', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  mockFetchPrices.mockResolvedValueOnce(new Map([['BTC', { price: 95000, change24h: 1.5 }]]));

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { data: { prices: Array<{ symbol: string; price: number; source: string }> } };
  expect(body.data.prices).toHaveLength(1);
  expect(body.data.prices[0]!.symbol).toBe('BTC');
  expect(body.data.prices[0]!.price).toBeCloseTo(95000);
  expect(body.data.prices[0]!.source).toBe('live');

  // Redis key should be set
  const cached = await redis.get('price:BTC');
  expect(cached).not.toBeNull();
  const parsed = JSON.parse(cached!) as { price: number };
  expect(parsed.price).toBeCloseTo(95000);
});

// ---------------------------------------------------------------------------
// 240. No symbols in body → derive from portfolio assets (first 5)
// ---------------------------------------------------------------------------

it('240: POST /prices/refresh with no symbols — derives first 5 from portfolio assets', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  // Create a manual portfolio with 2 assets
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  const eth = await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } });
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const portfolio = await prisma.portfolio.create({
    data: { userId, name: 'Main', typeId: portfolioType.id },
  });
  await prisma.asset.create({
    data: { portfolioId: portfolio.id, tokenId: btc.id, balance: '1', netDeposit: '90000' },
  });
  await prisma.asset.create({
    data: { portfolioId: portfolio.id, tokenId: eth.id, balance: '2', netDeposit: '6000' },
  });

  mockFetchPrices.mockResolvedValueOnce(new Map([
    ['BTC', { price: 94000, change24h: 0.5 }],
    ['ETH', { price: 3300, change24h: -0.2 }],
  ]));

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { data: { prices: Array<{ symbol: string }> } };
  const symbols = body.data.prices.map((p) => p.symbol);
  expect(symbols).toContain('BTC');
  expect(symbols).toContain('ETH');
});

// ---------------------------------------------------------------------------
// 241. Pro user → 403 PRO_USES_WEBSOCKET
// ---------------------------------------------------------------------------

it('241: POST /prices/refresh as pro user → 403 PRO_USES_WEBSOCKET', async () => {
  const cookie = await registerAndLogin(TEST_EMAIL_PRO);
  const userId = await getUserId(TEST_EMAIL_PRO);
  await createProSubForUser(userId);

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });

  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('PRO_USES_WEBSOCKET');
});

// ---------------------------------------------------------------------------
// 242. Rate limited — second call within 30s → 429
// ---------------------------------------------------------------------------

it('242: POST /prices/refresh rate-limited second call within 30s → 429 TOO_MANY_REQUESTS', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  mockFetchPrices.mockResolvedValue(new Map([['BTC', { price: 93000, change24h: 0 }]]));

  // First call — should succeed
  const first = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });
  expect(first.status).toBe(200);

  // Second call within window — should be rate-limited
  const second = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });
  expect(second.status).toBe(429);
  const body = await second.json() as { error: { code: string }; meta: { retryAfterMs: number } };
  expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  expect(body.meta.retryAfterMs).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 243. Unknown symbol → 400
// ---------------------------------------------------------------------------

it('243: POST /prices/refresh with symbols=[XYZ] (no Token row) → 400 UNKNOWN_SYMBOL', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['XYZ'] }),
  });

  expect(res.status).toBe(400);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('UNKNOWN_SYMBOL');
});

// ---------------------------------------------------------------------------
// 244. CMC throws → 200 with partialFailure=true; source=cache or db
// ---------------------------------------------------------------------------

it('244: POST /prices/refresh when CMC throws → 200 partialFailure=true; source is cache or db', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  mockFetchPrices.mockRejectedValueOnce(new Error('CMC timeout'));

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { data: { prices: Array<{ source: string }>; partialFailure: boolean } };
  expect(body.data.partialFailure).toBe(true);
  expect(['cache', 'db']).toContain(body.data.prices[0]!.source);
});

// ---------------------------------------------------------------------------
// 245. symbols.length=6 → 400 VALIDATION_ERROR (max 5)
// ---------------------------------------------------------------------------

it('245: POST /prices/refresh with 6 symbols → 400 VALIDATION_ERROR (max 5)', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'MATIC'] }),
  });

  expect(res.status).toBe(400);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 246. No auth → 401
// ---------------------------------------------------------------------------

it('246: POST /prices/refresh no auth → 401', async () => {
  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 388. Refresh busts the caller's derived caches (retrofit-18)
// ---------------------------------------------------------------------------

it("388: POST /prices/refresh deletes the caller's portfolio_pnl + analytics_* derived caches AND overview response cache", async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const portfolio = await prisma.portfolio.create({
    data: { userId, name: 'Main', typeId: portfolioType.id },
  });

  // Prime every derived-cache key for this portfolio, as GET /overview + analytics would
  // (60s TTL). These are exactly the keys the shared helper enumerates.
  const keys = portfolioDerivedCacheKeys(portfolio.id);
  for (const k of keys) await redis.set(k, JSON.stringify({ stale: true }), 'EX', 60);

  // retrofit-19: also prime the per-user overview response cache (one days/txLimit variant)
  // that getOverview wraps the whole payload in — refresh must evict this too or the cached
  // pre-refresh response is served until its 60s TTL lapses.
  const overviewKey = `overview:${userId}:30:10`;
  await redis.set(overviewKey, JSON.stringify({ stale: true }), 'EX', 60);

  mockFetchPrices.mockResolvedValueOnce(new Map([['BTC', { price: 95000, change24h: 1.5 }]]));

  const res = await app.request(`${PRICES_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbols: ['BTC'] }),
  });
  expect(res.status).toBe(200);

  // All four derived keys evicted → the next GET /overview recomputes with the fresh price.
  for (const k of keys) {
    expect(await redis.get(k)).toBeNull();
  }
  // And the overview response cache is evicted → the refreshed payload is rebuilt immediately.
  expect(await redis.get(overviewKey)).toBeNull();
});

// ---------------------------------------------------------------------------
// 389. A Redis failure during invalidation must NOT fail the refresh (retrofit-18)
// ---------------------------------------------------------------------------

it('389: POST /prices/refresh still succeeds when derived-cache invalidation throws (Redis down)', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);
  // A portfolio so the invalidation actually reaches redis.del (keys to delete).
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  await prisma.portfolio.create({ data: { userId, name: 'Main', typeId: portfolioType.id } });

  mockFetchPrices.mockResolvedValueOnce(new Map([['BTC', { price: 95000, change24h: 1.5 }]]));

  // Make the single invalidation redis.del reject; the .catch guard must swallow it.
  const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('redis down'));
  try {
    const res = await app.request(`${PRICES_BASE}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ symbols: ['BTC'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { prices: Array<{ symbol: string; source: string }> } };
    expect(body.data.prices[0]!.symbol).toBe('BTC');
    expect(body.data.prices[0]!.source).toBe('live'); // prices still written
    expect(delSpy).toHaveBeenCalled(); // invalidation was attempted
  } finally {
    delSpy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// retrofit-35 — GET /prices/debug source-visibility readout
// ---------------------------------------------------------------------------

it('r35a: GET /prices/debug?symbol=BTC → canonical source + per-exchange ageMs/stale', async () => {
  const cookie = await registerAndLogin();
  const now = Date.now();
  // Canonical (resolver shape) + one fresh + one stale per-exchange entry.
  await redis.set('price:BTC', JSON.stringify({ price: 65000, change24h: 1, source: 'coinbase', ts: now }));
  await redis.set('price:BTC:coinbase', JSON.stringify({ price: 65000, change24h: 1, quote: 'USD', ts: now }));
  await redis.set('price:BTC:kraken', JSON.stringify({ price: 64990, change24h: 1, quote: 'USD', ts: now - 20_000 }));

  const res = await app.request(`${PRICES_BASE}/debug?symbol=BTC`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      symbol: string;
      canonical: { price: number; source: string; ts: number } | null;
      sources: Record<string, { price: number; ageMs: number; stale: boolean }>;
    };
  };
  expect(body.data.symbol).toBe('BTC');
  expect(body.data.canonical?.source).toBe('coinbase');
  // Fresh coinbase tick → not stale; the 20s-old kraken tick → stale (>15s window).
  expect(body.data.sources.coinbase!.stale).toBe(false);
  expect(body.data.sources.kraken!.stale).toBe(true);
  expect(body.data.sources.coinbase!.ageMs).toBeGreaterThanOrEqual(0);
});

it('r35b: GET /prices/debug?symbol=ZZZ (no data) → canonical null, empty sources', async () => {
  const cookie = await registerAndLogin();
  const res = await app.request(`${PRICES_BASE}/debug?symbol=ZZZ`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { canonical: unknown; sources: Record<string, unknown> } };
  expect(body.data.canonical).toBeNull();
  expect(Object.keys(body.data.sources)).toHaveLength(0);
});

it('r35c: GET /prices/debug no symbol → board array of catalog symbols', async () => {
  const cookie = await registerAndLogin();
  const res = await app.request(`${PRICES_BASE}/debug`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { symbols: Array<{ symbol: string }> } };
  expect(Array.isArray(body.data.symbols)).toBe(true);
});

it('r35d: GET /prices/debug no auth → 401', async () => {
  const res = await app.request(`${PRICES_BASE}/debug?symbol=BTC`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// retrofit-43 — intraday price history (Redis buffer): schema, service, endpoint
// ---------------------------------------------------------------------------

it('r43-schema: historyQuerySchema upcases, dedupes, caps at 50, defaults range to 1H', () => {
  // Dedup (case-insensitive) + default range.
  const a = historyQuerySchema.parse({ symbols: 'btc, ETH ,Btc' });
  expect(a.symbols).toEqual(['BTC', 'ETH']);
  expect(a.range).toBe('1H');

  // Cap at 50 distinct symbols.
  const many = Array.from({ length: 60 }, (_, i) => `S${i}`).join(',');
  const b = historyQuerySchema.parse({ symbols: many, range: '1D' });
  expect(b.symbols).toHaveLength(50);
  expect(b.range).toBe('1D');
});

it('r43-svc-window: getPriceHistory filters to the range window and returns oldest→newest {t,p}', async () => {
  const now = 2_000_000_000_000;
  // Stored newest→oldest (resolver LPUSHes newest at head). Two within 1H, one 2h old.
  await redis.rpush(
    'price_hist:WIN',
    `${now - 1_000}|110`, // 1s ago  — in 1H + 1D
    `${now - 1_800_000}|105`, // 30m ago — in 1H + 1D
    `${now - 7_200_000}|100`, // 2h ago  — in 1D only
  );

  const h1 = await getPriceHistory(['WIN'], '1H', now);
  expect(h1.WIN).toEqual([
    { t: now - 1_800_000, p: 105 },
    { t: now - 1_000, p: 110 },
  ]); // oldest→newest, 2h-old point excluded

  const d1 = await getPriceHistory(['WIN'], '1D', now);
  expect(d1.WIN).toEqual([
    { t: now - 7_200_000, p: 100 },
    { t: now - 1_800_000, p: 105 },
    { t: now - 1_000, p: 110 },
  ]); // all three, oldest→newest
});

it('r43-svc-malformed: getPriceHistory skips legacy bare-price + malformed + non-positive entries', async () => {
  const now = 2_000_000_000_000;
  await redis.rpush(
    'price_hist:MIX',
    `${now - 1_000}|120`, // valid
    '99', // legacy bare price — no ts → skipped
    `${now - 2_000}|abc`, // non-finite price → skipped
    `${now - 3_000}|0`, // p<=0 → skipped
    `${now - 4_000}|118`, // valid
  );
  const h = await getPriceHistory(['MIX'], '1H', now);
  expect(h.MIX).toEqual([
    { t: now - 4_000, p: 118 },
    { t: now - 1_000, p: 120 },
  ]);
});

it('r43-svc-empty: unknown symbol → []; a Redis throw → [] (never throws)', async () => {
  const now = 2_000_000_000_000;
  const h = await getPriceHistory(['NOPE'], '1H', now);
  expect(h.NOPE).toEqual([]);

  const lrangeSpy = vi.spyOn(redis, 'lrange').mockRejectedValueOnce(new Error('redis down'));
  try {
    const h2 = await getPriceHistory(['BTC'], '1H', now);
    expect(h2.BTC).toEqual([]); // swallowed, never throws
    expect(lrangeSpy).toHaveBeenCalled();
  } finally {
    lrangeSpy.mockRestore();
  }
});

it('r43-ep-ok: GET /prices/history?symbols=BTC,ETH&range=1H → 200 { history: { SYM: [...] } }', async () => {
  const cookie = await registerAndLogin();
  const now = Date.now();
  await redis.rpush('price_hist:BTC', `${now - 1_000}|65000`, `${now - 120_000}|64900`);
  // ETH has no list → its series is [].

  const res = await app.request(`${PRICES_BASE}/history?symbols=BTC,ETH&range=1H`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { history: Record<string, Array<{ t: number; p: number }>> } };
  expect(body.data.history.BTC).toEqual([
    { t: now - 120_000, p: 64900 },
    { t: now - 1_000, p: 65000 },
  ]); // oldest→newest
  expect(body.data.history.ETH).toEqual([]);
});

it('r43-ep-missing: GET /prices/history with no symbols → 400 VALIDATION_ERROR', async () => {
  const cookie = await registerAndLogin();
  const res = await app.request(`${PRICES_BASE}/history`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('VALIDATION_ERROR');
});

it('r43-ep-badrange: GET /prices/history with range=5Y → 400 VALIDATION_ERROR', async () => {
  const cookie = await registerAndLogin();
  const res = await app.request(`${PRICES_BASE}/history?symbols=BTC&range=5Y`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('VALIDATION_ERROR');
});

it('r43-ep-auth: GET /prices/history no auth → 401', async () => {
  const res = await app.request(`${PRICES_BASE}/history?symbols=BTC&range=1H`);
  expect(res.status).toBe(401);
});
