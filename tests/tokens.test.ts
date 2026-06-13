// Neonfi backend — Tokens module integration tests (Stage 6).
//
// Strategy: real DB + Redis, per-test truncation of user/session/subscription/payment.
// Token table is NOT touched — tokens are seeded once via `npm run db:seed` and
// remain for the lifetime of the test run.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock — prevents real Resend calls during tests
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
const TOKENS_BASE = '/api/v1/tokens';
const TEST_EMAIL = 'tokens.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Tokens Integration';

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(): Promise<string> {
  await authPost('/register', { email: TEST_EMAIL, password: TEST_PASSWORD, fullName: TEST_FULL_NAME });
  const res = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
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

async function createProSubForUser(
  userId: number,
  opts: { status?: 'active' | 'cancelled' | 'expired'; currentPeriodEnd?: Date | null } = {},
): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({
    where: { name: opts.status ?? 'active' },
  });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd:
        opts.currentPeriodEnd !== undefined ? opts.currentPeriodEnd : new Date('2026-07-01T00:00:00Z'),
    },
  });
}

async function tokenGet(path: string, cookies?: string): Promise<Response> {
  return app.request(`${TOKENS_BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 124. GET /tokens — no auth → 401 UNAUTHENTICATED
// ---------------------------------------------------------------------------

it('124: GET /tokens — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await tokenGet('');
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 125. GET /tokens — user with no subscription → free tier (rank ≤ 10 only)
// ---------------------------------------------------------------------------

it('125: GET /tokens — no sub (defaults free) → 200, exactly 10 rank-≤10 tokens, nextCursor null', async () => {
  const cookies = await registerAndLogin();

  const res = await tokenGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { tokens: Array<{ rank: number | null }> };
    meta: { limit: number; nextCursor: number | null };
  };
  expect(json.data.tokens).toHaveLength(10);
  for (const token of json.data.tokens) {
    expect(token.rank).not.toBeNull();
    expect(token.rank!).toBeLessThanOrEqual(10);
  }
  expect(json.meta.nextCursor).toBeNull();
});

// ---------------------------------------------------------------------------
// 126. GET /tokens — active free sub → same free-tier gate (rank ≤ 10 only)
// ---------------------------------------------------------------------------

it('126: GET /tokens — active free sub → 200, rank ≤ 10 only, nextCursor null', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  const res = await tokenGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { tokens: Array<{ rank: number | null }> };
    meta: { nextCursor: number | null };
  };
  expect(json.data.tokens).toHaveLength(10);
  for (const token of json.data.tokens) {
    expect(token.rank!).toBeLessThanOrEqual(10);
  }
  expect(json.meta.nextCursor).toBeNull();
});

// ---------------------------------------------------------------------------
// 127. GET /tokens — pro user → rank > 10 tokens included, all 30 accessible
// ---------------------------------------------------------------------------

it('127: GET /tokens — pro user with limit=50 → 200, all 30 tokens, rank > 10 included', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res = await tokenGet('?limit=50', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { tokens: Array<{ rank: number | null }> } };
  expect(json.data.tokens).toHaveLength(30);
  const hasHighRank = json.data.tokens.some((t) => t.rank !== null && t.rank > 10);
  expect(hasHighRank).toBe(true);
});

// ---------------------------------------------------------------------------
// 128. GET /tokens — pro user, default limit=20 → 20 tokens, meta.limit=20, nextCursor set
// ---------------------------------------------------------------------------

it('128: GET /tokens — pro user, default limit → 20 tokens returned, meta.limit=20, nextCursor non-null', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res = await tokenGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { tokens: unknown[] };
    meta: { limit: number; nextCursor: number | null };
  };
  expect(json.data.tokens).toHaveLength(20);
  expect(json.meta.limit).toBe(20);
  expect(json.meta.nextCursor).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 129. GET /tokens — limit param respected
// ---------------------------------------------------------------------------

it('129: GET /tokens — limit=5 → 5 tokens returned, meta.limit=5', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res = await tokenGet('?limit=5', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { tokens: unknown[] };
    meta: { limit: number; nextCursor: number | null };
  };
  expect(json.data.tokens).toHaveLength(5);
  expect(json.meta.limit).toBe(5);
  expect(json.meta.nextCursor).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 130. GET /tokens — nextCursor non-null when more exist; null on last page
// ---------------------------------------------------------------------------

it('130: GET /tokens — nextCursor non-null when more exist, null when page exhausts results', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  // limit=10 of 30 → nextCursor set
  const res1 = await tokenGet('?limit=10', cookies);
  expect(res1.status).toBe(200);
  const json1 = await res1.json() as { meta: { nextCursor: number | null } };
  expect(json1.meta.nextCursor).not.toBeNull();

  // limit=50 of 30 → nextCursor null (all tokens fit on one page)
  const res2 = await tokenGet('?limit=50', cookies);
  expect(res2.status).toBe(200);
  const json2 = await res2.json() as { data: { tokens: unknown[] }; meta: { nextCursor: number | null } };
  expect(json2.meta.nextCursor).toBeNull();
  expect(json2.data.tokens).toHaveLength(30);
});

// ---------------------------------------------------------------------------
// 131. GET /tokens — cursor pagination: second page continues without overlap
// ---------------------------------------------------------------------------

it('131: GET /tokens — second page via cursor has no overlap with first, all IDs strictly greater', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res1 = await tokenGet('?limit=10', cookies);
  const json1 = await res1.json() as {
    data: { tokens: Array<{ id: number }> };
    meta: { nextCursor: number | null };
  };
  expect(json1.meta.nextCursor).not.toBeNull();
  const firstPageIds = json1.data.tokens.map((t) => t.id);

  const res2 = await tokenGet(`?limit=10&cursor=${json1.meta.nextCursor}`, cookies);
  expect(res2.status).toBe(200);
  const json2 = await res2.json() as {
    data: { tokens: Array<{ id: number }> };
    meta: { nextCursor: number | null };
  };
  expect(json2.data.tokens).toHaveLength(10);

  const secondPageIds = json2.data.tokens.map((t) => t.id);
  const overlap = firstPageIds.filter((id) => secondPageIds.includes(id));
  expect(overlap).toHaveLength(0);

  const maxFirst = Math.max(...firstPageIds);
  const minSecond = Math.min(...secondPageIds);
  expect(minSecond).toBeGreaterThan(maxFirst);
});

// ---------------------------------------------------------------------------
// 132. GET /tokens — search by name, case-insensitive
// ---------------------------------------------------------------------------

it('132: GET /tokens — search=solana (lowercase) matches Solana by name', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res = await tokenGet('?search=solana', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { tokens: Array<{ symbol: string; name: string }> } };
  const sol = json.data.tokens.find((t) => t.symbol === 'SOL');
  expect(sol).toBeDefined();
  expect(sol!.name).toBe('Solana');
});

// ---------------------------------------------------------------------------
// 133. GET /tokens — search by symbol, case-insensitive
// ---------------------------------------------------------------------------

it('133: GET /tokens — search=btc (lowercase) matches Bitcoin by symbol', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const res = await tokenGet('?search=btc', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { tokens: Array<{ symbol: string; name: string }> } };
  const btc = json.data.tokens.find((t) => t.symbol === 'BTC');
  expect(btc).toBeDefined();
  expect(btc!.name).toBe('Bitcoin');
});

// ---------------------------------------------------------------------------
// 134. GET /tokens — search with no match → empty array, nextCursor null
// ---------------------------------------------------------------------------

it('134: GET /tokens — search=ZZZNOMATCH → 200, empty tokens array, nextCursor null', async () => {
  const cookies = await registerAndLogin();

  const res = await tokenGet('?search=ZZZNOMATCH', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { tokens: unknown[] };
    meta: { nextCursor: number | null };
  };
  expect(json.data.tokens).toHaveLength(0);
  expect(json.meta.nextCursor).toBeNull();
});

// ---------------------------------------------------------------------------
// 135. GET /tokens/:id — valid token → 200, detail DTO shape
// ---------------------------------------------------------------------------

it('135: GET /tokens/:id — valid token → 200, detail DTO has id, name, symbol, logoUrl, currentPrice, rank, marketCap, updatedAt', async () => {
  const cookies = await registerAndLogin();
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });

  const res = await tokenGet(`/${btc.id}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { token: Record<string, unknown> } };
  const token = json.data.token;
  const keys = Object.keys(token).sort();
  expect(keys).toEqual(['currentPrice', 'id', 'logoUrl', 'marketCap', 'name', 'rank', 'symbol', 'updatedAt']);
  expect(token.id).toBe(btc.id);
  expect(token.name).toBe('Bitcoin');
  expect(token.symbol).toBe('BTC');
  expect(typeof token.currentPrice).toBe('number');
  expect(token.marketCap).not.toBeNull();
  expect(typeof token.updatedAt).toBe('string');
});

// ---------------------------------------------------------------------------
// 136. GET /tokens/:id — non-integer id → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

it('136: GET /tokens/:id — non-integer id "abc" → 400 VALIDATION_ERROR', async () => {
  const cookies = await registerAndLogin();

  const res = await tokenGet('/abc', cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 137. GET /tokens/:id — token not found → 404 TOKEN_NOT_FOUND
// ---------------------------------------------------------------------------

it('137: GET /tokens/:id — non-existent id 999999 → 404 TOKEN_NOT_FOUND', async () => {
  const cookies = await registerAndLogin();

  const res = await tokenGet('/999999', cookies);
  expect(res.status).toBe(404);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('TOKEN_NOT_FOUND');
});
