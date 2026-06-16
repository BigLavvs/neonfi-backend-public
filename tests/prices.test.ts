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

it("388: POST /prices/refresh deletes the caller's portfolio_pnl + analytics_* derived caches", async () => {
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
