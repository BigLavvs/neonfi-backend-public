// Neonfi backend — Payments module integration tests (Stage 4B).
//
// Strategy: real DB + Redis, per-test truncation. No Stripe mock needed —
// GET endpoints do not call Stripe.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, seedPayment, truncateAllUserData } from './helpers.js';

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
const PAY_BASE = '/api/v1/payments';
const TEST_EMAIL = 'payments.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Payments Integration';
const TEST_EMAIL_B = 'payments.b@neonfi.test';

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(email: string, password: string, fullName: string): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email: string): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function createSubscriptionForUser(userId: number): Promise<number> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  const sub = await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });
  return sub.id;
}

async function payGet(path: string, cookies?: string): Promise<Response> {
  return app.request(`${PAY_BASE}${path}`, {
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
// 99. GET /payments — auth, no payments
// ---------------------------------------------------------------------------

it('99: GET /payments — auth, no payments → 200, empty list, correct meta', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);

  const res = await payGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { payments: unknown[] }; meta: { limit: number; offset: number; total: number } };
  expect(json.data.payments).toEqual([]);
  expect(json.meta).toEqual({ limit: 20, offset: 0, total: 0 });
});

// ---------------------------------------------------------------------------
// 100. GET /payments — multiple payments, default pagination
// ---------------------------------------------------------------------------

it('100: GET /payments — multiple payments → returned newest-first, total correct, DTO fields present', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userId = await getUserId(TEST_EMAIL);
  const subId = await createSubscriptionForUser(userId);

  // Create 3 payments with distinct times (oldest → newest)
  await seedPayment({ userId, subscriptionId: subId, status: 'succeeded', amount: 1000,
    createdAt: new Date('2026-06-01T01:00:00Z') });
  await seedPayment({ userId, subscriptionId: subId, status: 'failed', amount: 2000,
    createdAt: new Date('2026-06-01T02:00:00Z') });
  await seedPayment({ userId, subscriptionId: subId, status: 'succeeded', amount: 3000,
    createdAt: new Date('2026-06-01T03:00:00Z') });

  const res = await payGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { payments: Record<string, unknown>[] }; meta: { total: number; limit: number; offset: number } };
  expect(json.meta.total).toBe(3);
  expect(json.meta.limit).toBe(20);
  expect(json.meta.offset).toBe(0);
  expect(json.data.payments).toHaveLength(3);

  // Newest first (amount 3000, 2000, 1000)
  expect(json.data.payments[0]!.amount).toBe(3000);
  expect(json.data.payments[2]!.amount).toBe(1000);

  // Check DTO fields on first payment
  const p = json.data.payments[0]!;
  expect(p).toHaveProperty('id');
  expect(p).toHaveProperty('userId');
  expect(p).toHaveProperty('subscriptionId');
  expect(p).toHaveProperty('stripePaymentIntentId');
  expect(p).toHaveProperty('amount');
  expect(p).toHaveProperty('currency');
  expect(p).toHaveProperty('status');
  expect(p).toHaveProperty('refundAvailable');
  expect(p).toHaveProperty('createdAt');
});

// ---------------------------------------------------------------------------
// 101. GET /payments — ?limit=5&offset=5 pagination
// ---------------------------------------------------------------------------

it('101: GET /payments — ?limit=5&offset=5 → returns 6th–10th payments, meta reflects params', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userId = await getUserId(TEST_EMAIL);
  const subId = await createSubscriptionForUser(userId);

  // Create 10 payments with distinct times; amount=i*100 where i=1 is oldest
  for (let i = 1; i <= 10; i++) {
    await seedPayment({
      userId,
      subscriptionId: subId,
      status: 'succeeded',
      amount: i * 100,
      createdAt: new Date(`2026-06-01T${String(i).padStart(2, '0')}:00:00Z`),
    });
  }

  const res = await payGet('?limit=5&offset=5', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { payments: Record<string, unknown>[] }; meta: Record<string, number> };
  expect(json.meta.limit).toBe(5);
  expect(json.meta.offset).toBe(5);
  expect(json.meta.total).toBe(10);
  expect(json.data.payments).toHaveLength(5);

  // DESC order: newest first = amount 1000, skip 5 = amount 500, 400, 300, 200, 100
  const amounts = json.data.payments.map((p) => p.amount as number);
  expect(amounts).toEqual([500, 400, 300, 200, 100]);
});

// ---------------------------------------------------------------------------
// 102. GET /payments — ?status=succeeded filter
// ---------------------------------------------------------------------------

it('102: GET /payments — ?status=succeeded → only succeeded payments, total = succeeded count', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userId = await getUserId(TEST_EMAIL);
  const subId = await createSubscriptionForUser(userId);

  await seedPayment({ userId, subscriptionId: subId, status: 'succeeded' });
  await seedPayment({ userId, subscriptionId: subId, status: 'failed' });
  await seedPayment({ userId, subscriptionId: subId, status: 'succeeded' });
  await seedPayment({ userId, subscriptionId: subId, status: 'pending' });

  const res = await payGet('?status=succeeded', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { payments: Record<string, unknown>[] }; meta: { total: number } };
  expect(json.meta.total).toBe(2);
  expect(json.data.payments).toHaveLength(2);
  expect(json.data.payments.every((p) => p.status === 'succeeded')).toBe(true);
});

// ---------------------------------------------------------------------------
// 103. GET /payments — cross-user isolation
// ---------------------------------------------------------------------------

it('103: GET /payments — cross-user isolation: user B sees empty list when only user A has payments', async () => {
  const cookiesA = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const cookiesB = await registerAndLogin(TEST_EMAIL_B, TEST_PASSWORD, 'User B');

  const userAId = await getUserId(TEST_EMAIL);
  const subAId = await createSubscriptionForUser(userAId);

  // Seed 3 payments for user A
  for (let i = 0; i < 3; i++) {
    await seedPayment({ userId: userAId, subscriptionId: subAId, status: 'succeeded' });
  }

  // User B's request should return 0 payments
  const res = await payGet('', cookiesB);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { payments: unknown[] }; meta: { total: number } };
  expect(json.data.payments).toHaveLength(0);
  expect(json.meta.total).toBe(0);

  // User A still sees their 3 payments
  const resA = await payGet('', cookiesA);
  const jsonA = await resA.json() as { data: { payments: unknown[] }; meta: { total: number } };
  expect(jsonA.data.payments).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// 104. GET /payments — no auth → 401
// ---------------------------------------------------------------------------

it('104: GET /payments — no auth → 401', async () => {
  const res = await payGet('');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 105. GET /payments — invalid limit → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

it('105: GET /payments — invalid limit (0 and 200) → 400 VALIDATION_ERROR', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);

  const resZero = await payGet('?limit=0', cookies);
  expect(resZero.status).toBe(400);
  const jsonZero = await resZero.json() as { error: { code: string } };
  expect(jsonZero.error.code).toBe('VALIDATION_ERROR');

  const res200 = await payGet('?limit=200', cookies);
  expect(res200.status).toBe(400);
  const json200 = await res200.json() as { error: { code: string } };
  expect(json200.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 106. GET /payments/:id — own payment, refundAvailable derived
// ---------------------------------------------------------------------------

it('106: GET /payments/:id — own payment → 200, refundAvailable=true for recent succeeded, false for old', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const userId = await getUserId(TEST_EMAIL);
  const subId = await createSubscriptionForUser(userId);

  // Recent succeeded payment → refundAvailable should be true (derived)
  const recent = await seedPayment({
    userId,
    subscriptionId: subId,
    status: 'succeeded',
    refundAvailable: true,
  });

  // Old succeeded payment (5 days ago) → refundAvailable should be false (derived: out of window)
  const old = await seedPayment({
    userId,
    subscriptionId: subId,
    status: 'succeeded',
    refundAvailable: true,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  });

  const resRecent = await payGet(`/${recent.id}`, cookies);
  expect(resRecent.status).toBe(200);
  const jsonRecent = await resRecent.json() as { data: { payment: Record<string, unknown> } };
  expect(jsonRecent.data.payment.id).toBe(recent.id);
  expect(jsonRecent.data.payment.refundAvailable).toBe(true);

  const resOld = await payGet(`/${old.id}`, cookies);
  expect(resOld.status).toBe(200);
  const jsonOld = await resOld.json() as { data: { payment: Record<string, unknown> } };
  expect(jsonOld.data.payment.id).toBe(old.id);
  expect(jsonOld.data.payment.refundAvailable).toBe(false);
});

// ---------------------------------------------------------------------------
// 107. GET /payments/:id — another user's payment → 403
// ---------------------------------------------------------------------------

it('107: GET /payments/:id — another user\'s payment → 403 FORBIDDEN', async () => {
  await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);
  const cookiesB = await registerAndLogin(TEST_EMAIL_B, TEST_PASSWORD, 'User B');

  const userAId = await getUserId(TEST_EMAIL);
  const subAId = await createSubscriptionForUser(userAId);
  const paymentA = await seedPayment({ userId: userAId, subscriptionId: subAId, status: 'succeeded' });

  // User B tries to access user A's payment
  const res = await payGet(`/${paymentA.id}`, cookiesB);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 108. GET /payments/:id — non-existent ID → 403 (uniform)
// ---------------------------------------------------------------------------

it('108: GET /payments/:id — non-existent ID → 403 FORBIDDEN (uniform with cross-user)', async () => {
  const cookies = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, TEST_FULL_NAME);

  const res = await payGet('/999999', cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});
