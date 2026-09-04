// Neonfi backend — Users module integration tests (Stage 2).
//
// Strategy: same as auth.test.ts — isolated test DB + Redis, per-test truncation.
// beforeEach truncates session and user tables, clears auth Redis keys.
// Uses Hono's app.request() for in-process HTTP.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { config } from '../src/lib/config.js';
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
// Avatar storage mock (retrofit-90) — tests never touch Cloudflare R2.
// `publicUrl` / `keyFromPublicUrl` mirror the real implementation against the
// .env R2_PUBLIC_BASE_URL (https://images.neonfi.live) so URL ⇄ key round-trips.
// ---------------------------------------------------------------------------

const R2_BASE = 'https://images.neonfi.live';

const { mockPutObject, mockDeleteObject } = vi.hoisted(() => ({
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock('../src/lib/storage.js', () => ({
  putObject: mockPutObject,
  deleteObject: mockDeleteObject,
  publicUrl: (key: string) => `https://images.neonfi.live/${key}`,
  keyFromPublicUrl: (url: string | null) => {
    const base = 'https://images.neonfi.live/';
    return url && url.startsWith(base) ? url.slice(base.length) : null;
  },
}));

// Toggle for `isAvatarStorageConfigured` so one test can exercise the 503 path.
// Every other config value passes through unchanged (real .env has the R2 vars set).
const { storageState } = vi.hoisted(() => ({ storageState: { configured: true } }));

vi.mock('../src/lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config.js')>();
  return {
    ...actual,
    get isAvatarStorageConfigured() {
      return storageState.configured;
    },
  };
});

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

// retrofit-90: multipart upload helper (field `file`). FormData sets the
// Content-Type (with boundary) automatically — do not set it by hand.
async function postFile(
  path: string,
  bytes: Uint8Array,
  filename: string,
  type: string,
  cookies?: string,
): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  return app.request(`${USERS_BASE}${path}`, {
    method: 'POST',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
    body: fd,
  });
}

// Minimal valid PNG header (magic bytes are all sniffImage inspects).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

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
  // retrofit-90: reset avatar storage mocks + the configured toggle each test.
  storageState.configured = true;
  mockPutObject.mockReset();
  mockPutObject.mockResolvedValue(undefined);
  mockDeleteObject.mockReset();
  mockDeleteObject.mockResolvedValue(undefined);
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
// 40. PATCH /users/me — avatarUrl is rejected (managed via POST /me/avatar only)
// ---------------------------------------------------------------------------

it('40: PATCH /users/me rejects avatarUrl (avatars are set via POST /me/avatar, audit SEC #4/#23)', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { avatarUrl: 'https://example.com/avatar.png' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');

  // The avatar was NOT set via this path.
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBeNull();
});

// ---------------------------------------------------------------------------
// 41. PATCH /users/me — avatarUrl:null also rejected (clear via DELETE /me/avatar)
// ---------------------------------------------------------------------------

it('41: PATCH /users/me rejects avatarUrl:null too (clearing is via DELETE /me/avatar)', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { avatarUrl: null }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
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

// ---------------------------------------------------------------------------
// 60. POST /users/me/avatar — happy path: PNG uploaded, public URL persisted.
// ---------------------------------------------------------------------------

it('60: POST /users/me/avatar uploads a PNG and persists the public URL', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await postFile('/me/avatar', PNG_BYTES, 'pic.png', 'image/png', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: { avatarUrl: string } } };
  const url = json.data.user.avatarUrl;
  expect(url.startsWith(`${R2_BASE}/avatars/`)).toBe(true);
  expect(url.endsWith('.png')).toBe(true);

  // putObject called exactly once with an avatars/<id>/<uuid>.png key + sniffed type
  expect(mockPutObject).toHaveBeenCalledTimes(1);
  const [key, , contentType] = mockPutObject.mock.calls[0]!;
  expect(key).toMatch(/^avatars\/\d+\/[0-9a-f-]+\.png$/);
  expect(contentType).toBe('image/png');

  // Persisted in the DB
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBe(url);
});

// ---------------------------------------------------------------------------
// 61. POST /users/me/avatar — non-image bytes → 400 (sniff, not Content-Type).
// ---------------------------------------------------------------------------

it('61: POST /users/me/avatar rejects non-image bytes with 400 UNSUPPORTED_MEDIA_TYPE', async () => {
  const sessionCookie = await registerAndLogin();

  // Lie about the type (image/png) but send junk bytes — magic-byte sniff must reject.
  const res = await postFile('/me/avatar', new Uint8Array([1, 2, 3, 4, 5, 6]), 'x.png', 'image/png', sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  expect(mockPutObject).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 62. POST /users/me/avatar — oversize image → 400 FILE_TOO_LARGE.
// ---------------------------------------------------------------------------

it('62: POST /users/me/avatar rejects an oversize image with 400 FILE_TOO_LARGE', async () => {
  const sessionCookie = await registerAndLogin();

  const big = new Uint8Array(config.AVATAR_MAX_BYTES + 1);
  big.set(PNG_BYTES); // valid PNG sig, but the size guard fires before the sniff
  const res = await postFile('/me/avatar', big, 'big.png', 'image/png', sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FILE_TOO_LARGE');
  expect(mockPutObject).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 63. POST /users/me/avatar — no auth → 401.
// ---------------------------------------------------------------------------

it('63: POST /users/me/avatar without auth returns 401', async () => {
  const res = await postFile('/me/avatar', PNG_BYTES, 'pic.png', 'image/png');
  expect(res.status).toBe(401);
  expect(mockPutObject).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 64. POST /users/me/avatar — replacing an avatar deletes the previous object.
// ---------------------------------------------------------------------------

it('64: POST /users/me/avatar deletes the previously stored object', async () => {
  const sessionCookie = await registerAndLogin();

  const first = await postFile('/me/avatar', PNG_BYTES, 'a.png', 'image/png', sessionCookie);
  const firstUrl = (await first.json() as { data: { user: { avatarUrl: string } } }).data.user.avatarUrl;
  const oldKey = firstUrl.slice(`${R2_BASE}/`.length);
  // No prior avatar on the first upload → nothing to delete.
  expect(mockDeleteObject).not.toHaveBeenCalled();

  const second = await postFile('/me/avatar', PNG_BYTES, 'b.png', 'image/png', sessionCookie);
  expect(second.status).toBe(200);
  expect(mockDeleteObject).toHaveBeenCalledWith(oldKey);
});

// ---------------------------------------------------------------------------
// 65. DELETE /users/me/avatar — clears avatarUrl and deletes the stored object.
// ---------------------------------------------------------------------------

it('65: DELETE /users/me/avatar clears avatarUrl and deletes the stored object', async () => {
  const sessionCookie = await registerAndLogin();

  const up = await postFile('/me/avatar', PNG_BYTES, 'a.png', 'image/png', sessionCookie);
  const url = (await up.json() as { data: { user: { avatarUrl: string } } }).data.user.avatarUrl;
  const key = url.slice(`${R2_BASE}/`.length);
  mockDeleteObject.mockClear();

  const res = await del('/me/avatar', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: { avatarUrl: string | null } } };
  expect(json.data.user.avatarUrl).toBeNull();
  expect(mockDeleteObject).toHaveBeenCalledWith(key);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBeNull();
});

// ---------------------------------------------------------------------------
// 66. POST /users/me/avatar — storage unconfigured → 503.
// ---------------------------------------------------------------------------

it('66: POST /users/me/avatar returns 503 AVATAR_STORAGE_UNAVAILABLE when storage is unconfigured', async () => {
  storageState.configured = false;
  const sessionCookie = await registerAndLogin();

  const res = await postFile('/me/avatar', PNG_BYTES, 'pic.png', 'image/png', sessionCookie);
  expect(res.status).toBe(503);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('AVATAR_STORAGE_UNAVAILABLE');
  expect(mockPutObject).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 67. POST /users/me/avatar — missing file field → 400 VALIDATION_ERROR.
// ---------------------------------------------------------------------------

it('67: POST /users/me/avatar with no file field returns 400 VALIDATION_ERROR', async () => {
  const sessionCookie = await registerAndLogin();

  const fd = new FormData();
  fd.append('notfile', 'hello');
  const res = await app.request(`${USERS_BASE}/me/avatar`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
    body: fd,
  });
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
  expect(mockPutObject).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 68. DELETE /users/me/avatar — no auth → 401.
// ---------------------------------------------------------------------------

it('68: DELETE /users/me/avatar without auth returns 401', async () => {
  const res = await del('/me/avatar');
  expect(res.status).toBe(401);
});
