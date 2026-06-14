// Neonfi backend — Users module integration tests (Stage 2).
//
// Strategy: same as auth.test.ts — dev DB + Redis, per-test truncation.
// beforeEach truncates session and user tables, clears auth Redis keys.
// Uses Hono's app.request() for in-process HTTP.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, cookieMaxAge, clearRedisAuthKeys, seedPayment, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Stripe mock — retrofit-5: DELETE /users/me cancels an active Pro sub at Stripe
// (via the subscriptions service). Same hoisted-mock pattern as subscriptions.test.ts.
// ---------------------------------------------------------------------------

const { mockSubscriptionsUpdate } = vi.hoisted(() => ({
  mockSubscriptionsUpdate: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: vi.fn() } },
    subscriptions: { update: mockSubscriptionsUpdate, retrieve: vi.fn() },
    subscriptionSchedules: { create: vi.fn(), update: vi.fn() },
    refunds: { create: vi.fn() },
  }));
  return { default: Stripe };
});

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
const USERS_BASE = '/api/v1/users';

const TEST_EMAIL = 'users.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Users Integration';

async function authPost(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookies?: string): Promise<Response> {
  return app.request(`${USERS_BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function patch(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${USERS_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function del(path: string, cookies?: string): Promise<Response> {
  return app.request(`${USERS_BASE}${path}`, {
    method: 'DELETE',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function registerAndLogin(): Promise<string> {
  await authPost('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });
  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  return `session=${cookieValue(loginRes, 'session')!}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 35. GET /users/me — full DTO with all fields, no sensitive data
// ---------------------------------------------------------------------------

it('35: GET /users/me returns full DTO with correct fields', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await get('/me', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  const user = json.data.user;

  // Identity fields
  expect(typeof user.id).toBe('number');
  expect(user.email).toBe(TEST_EMAIL);
  expect(user.fullName).toBe(TEST_FULL_NAME);
  expect(user.displayName).toBeNull();
  expect(user.avatarUrl).toBeNull();
  expect(user.authProvider).toBe('email');

  // Gate D: pending_verification user has emailVerified=false
  expect(user.emailVerified).toBe(false);
  expect(user.onboardingStatus).toBe('pending_verification');

  // Stage 2 fields
  expect(user.plan).toBeNull();
  expect(user.billingCycle).toBeNull();
  expect(user.newsletterSubscribed).toBe(false);
  expect(user.createdAt).toBeTruthy();
  expect(user.updatedAt).toBeTruthy();

  // Sensitive fields MUST NOT be exposed
  expect(user).not.toHaveProperty('passwordHash');
  expect(user).not.toHaveProperty('authProviderId');
  expect(user).not.toHaveProperty('onboardingStatusId');
});

// ---------------------------------------------------------------------------
// 36. GET /users/me — verified user shows emailVerified=true
// ---------------------------------------------------------------------------

it('36: GET /users/me — emailVerified is true after email verification', async () => {
  await authPost('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });

  // Grab the verification token from Redis and verify
  const keys = await redis.keys('email_verify:*');
  const token = keys[0]!.replace('email_verify:', '');
  await authPost('/verify-email', { token });

  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const sessionCookie = `session=${cookieValue(loginRes, 'session')!}`;

  const res = await get('/me', sessionCookie);
  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.emailVerified).toBe(true);
  expect(json.data.user.onboardingStatus).toBe('verified');
});

// ---------------------------------------------------------------------------
// 37. GET /users/me — unauthenticated → 401
// ---------------------------------------------------------------------------

it('37: GET /users/me without auth returns 401', async () => {
  const res = await get('/me');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 38. PATCH /users/me — update displayName
// ---------------------------------------------------------------------------

it('38: PATCH /users/me updates displayName in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { displayName: 'Neo' }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.displayName).toBe('Neo');

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.displayName).toBe('Neo');
});

// ---------------------------------------------------------------------------
// 39. PATCH /users/me — update fullName
// ---------------------------------------------------------------------------

it('39: PATCH /users/me updates fullName in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { fullName: 'Updated Name' }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.fullName).toBe('Updated Name');

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.fullName).toBe('Updated Name');
});

// ---------------------------------------------------------------------------
// 40. PATCH /users/me — update avatarUrl
// ---------------------------------------------------------------------------

it('40: PATCH /users/me updates avatarUrl in response and DB', async () => {
  const sessionCookie = await registerAndLogin();
  const url = 'https://example.com/avatar.png';

  const res = await patch('/me', { avatarUrl: url }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.avatarUrl).toBe(url);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBe(url);
});

// ---------------------------------------------------------------------------
// 41. PATCH /users/me — avatarUrl: null clears the field
// ---------------------------------------------------------------------------

it('41: PATCH /users/me with avatarUrl:null clears the field', async () => {
  const sessionCookie = await registerAndLogin();

  // Set it first
  await patch('/me', { avatarUrl: 'https://example.com/avatar.png' }, sessionCookie);

  // Now clear it
  const res = await patch('/me', { avatarUrl: null }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.avatarUrl).toBeNull();

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBeNull();
});

// ---------------------------------------------------------------------------
// 42. PATCH /users/me — toggle newsletterSubscribed
// ---------------------------------------------------------------------------

it('42: PATCH /users/me toggles newsletterSubscribed in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { newsletterSubscribed: true }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.newsletterSubscribed).toBe(true);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.newsletterSubscribed).toBe(true);
});

// ---------------------------------------------------------------------------
// 43. PATCH /users/me — multiple fields updated atomically
// ---------------------------------------------------------------------------

it('43: PATCH /users/me updates multiple fields atomically', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch(
    '/me',
    {
      fullName: 'Atomic User',
      displayName: 'Atomic',
      newsletterSubscribed: true,
    },
    sessionCookie,
  );
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.fullName).toBe('Atomic User');
  expect(json.data.user.displayName).toBe('Atomic');
  expect(json.data.user.newsletterSubscribed).toBe(true);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.fullName).toBe('Atomic User');
  expect(dbUser.displayName).toBe('Atomic');
  expect(dbUser.newsletterSubscribed).toBe(true);
});

// ---------------------------------------------------------------------------
// 44. PATCH /users/me — empty body → 200 no-op
// ---------------------------------------------------------------------------

it('44: PATCH /users/me with empty body returns 200 with current user', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', {}, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.email).toBe(TEST_EMAIL);
  expect(json.data.user.fullName).toBe(TEST_FULL_NAME);
});

// ---------------------------------------------------------------------------
// 45. PATCH /users/me — unknown field → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

it('45: PATCH /users/me with unknown field returns 400 VALIDATION_ERROR', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { email: 'new@example.com' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 46. PATCH /users/me — fullName too long → 400
// ---------------------------------------------------------------------------

it('46: PATCH /users/me rejects fullName longer than 255 chars', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { fullName: 'A'.repeat(256) }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 47. PATCH /users/me — displayName empty string → 400 (use null to clear)
// ---------------------------------------------------------------------------

it('47: PATCH /users/me rejects displayName empty string', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { displayName: '' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 48. PATCH /users/me — avatarUrl not a URL → 400
// ---------------------------------------------------------------------------

it('48: PATCH /users/me rejects avatarUrl that is not a valid URL', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { avatarUrl: 'not-a-url' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 49. PATCH /users/me — no auth → 401
// ---------------------------------------------------------------------------

it('49: PATCH /users/me without auth returns 401', async () => {
  const res = await patch('/me', { displayName: 'Ghost' });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 50. PATCH /users/me — readback: GET confirms persisted changes
// ---------------------------------------------------------------------------

it('50: readback — GET /users/me returns values matching the PATCH response', async () => {
  const sessionCookie = await registerAndLogin();

  const patchRes = await patch(
    '/me',
    { displayName: 'Persist Check', newsletterSubscribed: true },
    sessionCookie,
  );
  const patchJson = await patchRes.json() as { data: { user: Record<string, unknown> } };

  const getRes = await get('/me', sessionCookie);
  const getJson = await getRes.json() as { data: { user: Record<string, unknown> } };

  expect(getJson.data.user.displayName).toBe('Persist Check');
  expect(getJson.data.user.newsletterSubscribed).toBe(true);
  expect(getJson.data.user.displayName).toBe(patchJson.data.user.displayName);
  expect(getJson.data.user.newsletterSubscribed).toBe(patchJson.data.user.newsletterSubscribed);
});

// ---------------------------------------------------------------------------
// 51. GET /users/me — active Pro subscription → plan and billingCycle populated
// ---------------------------------------------------------------------------

it('51: GET /users/me with active Pro subscription → plan: pro, billingCycle: monthly', async () => {
  await authPost('/register', { email: TEST_EMAIL, password: TEST_PASSWORD, fullName: TEST_FULL_NAME });

  // Directly create a Pro subscription row (simulates Stage 4 webhook result)
  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const [plan, cycle, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });

  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const sessionCookie = `session=${cookieValue(loginRes, 'session')!}`;

  const res = await get('/me', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.plan).toBe('pro');
  expect(json.data.user.billingCycle).toBe('monthly');
});

// ---------------------------------------------------------------------------
// 52. GET /users/me — cancelled Pro with future currentPeriodEnd → still pro
// ---------------------------------------------------------------------------

it('52: GET /users/me with cancelled-but-in-period Pro → plan: pro (effectively active)', async () => {
  await authPost('/register', { email: TEST_EMAIL, password: TEST_PASSWORD, fullName: TEST_FULL_NAME });

  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const [plan, cycle, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'cancelled' } }),
  ]);
  await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'), // future relative to 2026-06-12
    },
  });

  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const sessionCookie = `session=${cookieValue(loginRes, 'session')!}`;

  const res = await get('/me', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.plan).toBe('pro');
  expect(json.data.user.billingCycle).toBe('monthly');
});

// ---------------------------------------------------------------------------
// 53. DELETE /users/me — hard delete: cascades remove user data, payment history
//     survives with null FKs (delta A), cookies cleared, old cookie → 401.
// ---------------------------------------------------------------------------

it('53: DELETE /users/me deletes account + cascades, preserves payment with null FKs, clears cookies', async () => {
  const sessionCookie = await registerAndLogin();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });

  // Seed a (free) subscription + a succeeded payment + a portfolio + sessions exist.
  // Free plan → getEffectivePlan returns 'free' → no Stripe call (isolates the
  // cascade/payment-survival assertion from the Pro-cancel path tested in 54).
  const [freePlan, activeStatus, manualType] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
    prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } }),
  ]);
  const sub = await prisma.subscription.create({
    data: { userId: user.id, planId: freePlan.id, statusId: activeStatus.id },
  });
  const payment = await seedPayment({ userId: user.id, subscriptionId: sub.id, status: 'succeeded' });
  const portfolio = await prisma.portfolio.create({
    data: { userId: user.id, name: 'My Portfolio', typeId: manualType.id },
  });
  expect(await prisma.session.count({ where: { userId: user.id } })).toBeGreaterThan(0);

  const res = await del('/me', sessionCookie);
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { deleted: boolean } };
  expect(json.data.deleted).toBe(true);

  // User + cascading children gone
  expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  expect(await prisma.portfolio.findUnique({ where: { id: portfolio.id } })).toBeNull();
  expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

  // Payment history SURVIVES with both FKs null (delta A — proves Restrict no longer bites)
  const survived = await prisma.payment.findUnique({ where: { id: payment.id } });
  expect(survived).not.toBeNull();
  expect(survived!.userId).toBeNull();
  expect(survived!.subscriptionId).toBeNull();
  expect(survived!.stripePaymentIntentId).toBe(payment.stripePaymentIntentId);
  expect(survived!.amount).toBe(payment.amount);

  // Cookies cleared (Set-Cookie with Max-Age=0 for both session and refresh)
  expect(cookieMaxAge(res, 'session')).toBe(0);
  expect(cookieMaxAge(res, 'refresh')).toBe(0);

  // Old session cookie no longer authenticates (session row cascade-deleted) → 401
  const followUp = await get('/me', sessionCookie);
  expect(followUp.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 54. DELETE /users/me with an effectively-active Pro sub → Stripe cancel first.
// ---------------------------------------------------------------------------

it('54: DELETE /users/me with active Pro subscription cancels at Stripe before deleting', async () => {
  mockSubscriptionsUpdate.mockReset();
  mockSubscriptionsUpdate.mockResolvedValue({});

  const sessionCookie = await registerAndLogin();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });

  const [proPlan, monthly, activeStatus] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: proPlan.id,
      billingCycleId: monthly.id,
      statusId: activeStatus.id,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test_del',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });

  const res = await del('/me', sessionCookie);
  expect(res.status).toBe(200);

  // Stripe cancel invoked (cancel_at_period_end) before the row is deleted
  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test_del', { cancel_at_period_end: true });

  // User deleted
  expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
});

// ---------------------------------------------------------------------------
// 55. DELETE /users/me — no auth → 401
// ---------------------------------------------------------------------------

it('55: DELETE /users/me without auth returns 401', async () => {
  const res = await del('/me');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 56. PATCH /users/preferences — defaults on GET, then each field updates + GET reflects.
// ---------------------------------------------------------------------------

it('56: PATCH /users/preferences updates all preference fields; GET /users/me reflects them', async () => {
  const sessionCookie = await registerAndLogin();

  // Defaults surfaced on GET /users/me
  const before = await get('/me', sessionCookie);
  const beforeJson = await before.json() as { data: { user: Record<string, unknown> } };
  expect(beforeJson.data.user.priceAlertsEnabled).toBe(true);
  expect(beforeJson.data.user.pushEnabled).toBe(false);
  expect(beforeJson.data.user.baseCurrency).toBe('USD');

  const res = await patch(
    '/preferences',
    { newsletterSubscribed: true, priceAlertsEnabled: false, pushEnabled: true, baseCurrency: 'EUR' },
    sessionCookie,
  );
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.newsletterSubscribed).toBe(true);
  expect(json.data.user.priceAlertsEnabled).toBe(false);
  expect(json.data.user.pushEnabled).toBe(true);
  expect(json.data.user.baseCurrency).toBe('EUR');

  // GET reflects the persisted values
  const getRes = await get('/me', sessionCookie);
  const getJson = await getRes.json() as { data: { user: Record<string, unknown> } };
  expect(getJson.data.user.priceAlertsEnabled).toBe(false);
  expect(getJson.data.user.pushEnabled).toBe(true);
  expect(getJson.data.user.baseCurrency).toBe('EUR');

  // DB matches
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.priceAlertsEnabled).toBe(false);
  expect(dbUser.pushEnabled).toBe(true);
  expect(dbUser.baseCurrency).toBe('EUR');
});

// ---------------------------------------------------------------------------
// 57. PATCH /users/preferences — unknown field → 400 (.strict())
// ---------------------------------------------------------------------------

it('57: PATCH /users/preferences with unknown field returns 400 VALIDATION_ERROR', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/preferences', { darkMode: true }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 58. PATCH /users/preferences — invalid baseCurrency → 400
// ---------------------------------------------------------------------------

it('58: PATCH /users/preferences rejects an unsupported baseCurrency', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/preferences', { baseCurrency: 'CAD' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 59. PATCH /users/preferences — no auth → 401
// ---------------------------------------------------------------------------

it('59: PATCH /users/preferences without auth returns 401', async () => {
  const res = await patch('/preferences', { pushEnabled: true });
  expect(res.status).toBe(401);
});
