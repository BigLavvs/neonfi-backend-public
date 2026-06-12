// Neonfi backend — Plan middleware unit tests (Stage 3B).
//
// Unit-style: no real DB calls. Prisma is mocked so we can inject arbitrary
// subscription states without seeding the database.
//
// Test app has two plan-gated routes:
//   GET /pro-only       — requirePlan(['pro'])
//   GET /free-or-pro    — requirePlan(['free', 'pro'])
//
// A pre-route middleware injects a stub user (id: 1) so requirePlan can read
// user.id without a session cookie or requireAuth running.

import { it, beforeEach, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { requirePlan } from '../src/modules/auth/plan.js';
import type { AuthEnv } from '../src/modules/auth/middleware.js';

// ---------------------------------------------------------------------------
// Prisma mock — intercepts subscription.findUnique in requirePlan
// ---------------------------------------------------------------------------

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    subscription: {
      findUnique: mockFindUnique,
    },
  },
}));

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const MOCK_USER = { id: 1 } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const testApp = new Hono<AuthEnv>();
testApp.use('*', (c, next) => {
  // Inject stub user so requirePlan can read c.get('user').id
  c.set('user', MOCK_USER);
  return next();
});
testApp.get('/pro-only', requirePlan(['pro']), (c) => c.json({ ok: true }));
testApp.get('/free-or-pro', requirePlan(['free', 'pro']), (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 53. No subscription → 403 SUBSCRIPTION_REQUIRED
// ---------------------------------------------------------------------------

it('53: no subscription → 403 SUBSCRIPTION_REQUIRED', async () => {
  mockFindUnique.mockResolvedValue(null);

  const res = await testApp.request('/pro-only');
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('SUBSCRIPTION_REQUIRED');
});

// ---------------------------------------------------------------------------
// 54. Expired subscription → 403 SUBSCRIPTION_EXPIRED
// ---------------------------------------------------------------------------

it('54: expired subscription → 403 SUBSCRIPTION_EXPIRED', async () => {
  mockFindUnique.mockResolvedValue({
    status: { name: 'expired' },
    plan: { name: 'pro' },
    currentPeriodEnd: new Date(Date.now() - 1000 * 60 * 60 * 24),
  });

  const res = await testApp.request('/pro-only');
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('SUBSCRIPTION_EXPIRED');
});

// ---------------------------------------------------------------------------
// 55. Active free subscription on /pro-only → 403 PLAN_LIMIT_REACHED
// ---------------------------------------------------------------------------

it('55: active free subscription on /pro-only → 403 PLAN_LIMIT_REACHED', async () => {
  mockFindUnique.mockResolvedValue({
    status: { name: 'active' },
    plan: { name: 'free' },
    currentPeriodEnd: null,
  });

  const res = await testApp.request('/pro-only');
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
});

// ---------------------------------------------------------------------------
// 56. Active pro subscription on /pro-only → 200
// ---------------------------------------------------------------------------

it('56: active pro subscription on /pro-only → 200', async () => {
  mockFindUnique.mockResolvedValue({
    status: { name: 'active' },
    plan: { name: 'pro' },
    currentPeriodEnd: null,
  });

  const res = await testApp.request('/pro-only');
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 57. Cancelled-but-in-period pro subscription on /pro-only → 200
// ---------------------------------------------------------------------------

it('57: cancelled-but-in-period pro on /pro-only → 200 (still effectively active)', async () => {
  mockFindUnique.mockResolvedValue({
    status: { name: 'cancelled' },
    plan: { name: 'pro' },
    currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days future
  });

  const res = await testApp.request('/pro-only');
  expect(res.status).toBe(200);
});
