// Neonfi backend — Chains module integration tests (Stage 5).
//
// Strategy: real DB + Redis, per-test truncation of user/session/subscription/payment.
// Chain table is NOT touched — chains are seeded once via `npm run db:seed` and
// remain for the lifetime of the test run.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';
import { CHAINS } from '../src/modules/chains/chains.constants.js';

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
const CHAINS_BASE = '/api/v1/chains';
const TEST_EMAIL = 'chains.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Chains Integration';

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

async function chainGet(path: string, cookies?: string): Promise<Response> {
  return app.request(`${CHAINS_BASE}${path}`, {
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
// 116. GET /chains — free user (active free subscription) → 3 chains
// ---------------------------------------------------------------------------

it('116: GET /chains — free user (active free sub) → 200, exactly 3 chains: eth, polygon, bnb', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSubForUser(userId);

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Array<{ slug: string }> } };
  expect(json.data.chains).toHaveLength(3);
  expect(json.data.chains.map((c) => c.slug)).toEqual(['eth', 'polygon', 'bnb']);
});

// ---------------------------------------------------------------------------
// 117. GET /chains — pro user (active pro subscription) → 15 chains
// ---------------------------------------------------------------------------

it('117: GET /chains — pro user (active pro sub) → 200, all 15 chains in seed order', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId, { status: 'active' });

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Array<{ slug: string }> } };
  expect(json.data.chains).toHaveLength(15);
  expect(json.data.chains[0]!.slug).toBe('eth');
  expect(json.data.chains[1]!.slug).toBe('polygon');
  expect(json.data.chains[2]!.slug).toBe('bnb');
  expect(json.data.chains[14]!.slug).toBe('mantle');
});

// ---------------------------------------------------------------------------
// 118. GET /chains — mid-onboarding user (no subscription) → 3 chains
// ---------------------------------------------------------------------------

it('118: GET /chains — mid-onboarding user (no sub) → 200, 3 free-tier chains', async () => {
  const cookies = await registerAndLogin();

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Array<{ slug: string }> } };
  expect(json.data.chains).toHaveLength(3);
  expect(json.data.chains.map((c) => c.slug)).toEqual(['eth', 'polygon', 'bnb']);
});

// ---------------------------------------------------------------------------
// 119. GET /chains — expired pro user → 3 chains (defaults to free)
// ---------------------------------------------------------------------------

it('119: GET /chains — expired pro user → 200, 3 free-tier chains (expired falls back to free)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId, {
    status: 'expired',
    currentPeriodEnd: new Date('2025-07-01T00:00:00Z'), // past
  });

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Array<{ slug: string }> } };
  expect(json.data.chains).toHaveLength(3);
  expect(json.data.chains.map((c) => c.slug)).toEqual(['eth', 'polygon', 'bnb']);
});

// ---------------------------------------------------------------------------
// 120. GET /chains — cancelled-but-in-period pro user → 15 chains
// ---------------------------------------------------------------------------

it('120: GET /chains — cancelled-in-period pro user → 200, all 15 chains (still effectively pro)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId, {
    status: 'cancelled',
    currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
  });

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Array<{ slug: string }> } };
  expect(json.data.chains).toHaveLength(15);
});

// ---------------------------------------------------------------------------
// 121. GET /chains — no auth → 401
// ---------------------------------------------------------------------------

it('121: GET /chains — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await chainGet('');
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 122. GET /chains — DTO shape: exactly 5 fields per chain
// ---------------------------------------------------------------------------

it('122: GET /chains — DTO shape has exactly id, name, slug, logoUrl, moralisId; no extras', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId, { status: 'active' });

  const res = await chainGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { chains: Record<string, unknown>[] } };
  expect(json.data.chains.length).toBeGreaterThan(0);

  for (const chain of json.data.chains) {
    const keys = Object.keys(chain).sort();
    expect(keys).toEqual(['id', 'logoUrl', 'moralisId', 'name', 'slug']);
    expect(typeof chain.id).toBe('number');
    expect(typeof chain.name).toBe('string');
    expect(typeof chain.slug).toBe('string');
    expect(chain.logoUrl === null || typeof chain.logoUrl === 'string').toBe(true);
    expect(typeof chain.moralisId).toBe('string');
  }
});

// ---------------------------------------------------------------------------
// 123. Seed idempotency — chain table stays at 15 after double upsert
// ---------------------------------------------------------------------------

it('123: Seed idempotency — running chain upserts twice keeps count at 15', async () => {
  const runUpsert = async () => {
    for (const chain of CHAINS) {
      await prisma.chain.upsert({
        where: { slug: chain.slug },
        update: { name: chain.name, moralisId: chain.moralisId, logoUrl: chain.logoUrl },
        create: chain,
      });
    }
  };

  await runUpsert();
  const count1 = await prisma.chain.count();
  expect(count1).toBe(15);

  await runUpsert();
  const count2 = await prisma.chain.count();
  expect(count2).toBe(15);
});
