// Neonfi backend — Subscriptions module integration tests (Stage 3A).
//
// Strategy: same as auth/users — isolated test DB + Redis, per-test truncation.
// Stripe and email module are mocked so no real API calls occur.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, seedPayment, truncateAllUserData } from './helpers.js';
import { config } from '../src/lib/config.js';

// ---------------------------------------------------------------------------
// Stripe mock — prevents real Stripe API calls during tests
// ---------------------------------------------------------------------------
const {
  mockCreateSession,
  mockSubscriptionsUpdate,
  mockSubscriptionsRetrieve,
  mockSubscriptionSchedulesCreate,
  mockSubscriptionSchedulesUpdate,
  mockRefundsCreate,
} = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSubscriptionsUpdate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionSchedulesCreate: vi.fn(),
  mockSubscriptionSchedulesUpdate: vi.fn(),
  mockRefundsCreate: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCreateSession } },
    subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
    subscriptionSchedules: { create: mockSubscriptionSchedulesCreate, update: mockSubscriptionSchedulesUpdate },
    refunds: { create: mockRefundsCreate },
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
const SUBS_BASE = '/api/v1/subscriptions';
const TEST_EMAIL = 'subs.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Subs Integration';

async function authPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${SUBS_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookies?: string): Promise<Response> {
  return app.request(`${SUBS_BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function registerUser(): Promise<void> {
  await authPost('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });
}

async function loginUser(): Promise<string> {
  const res = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  return `session=${cookieValue(res, 'session')!}`;
}

async function setOnboardingStatus(email: string, statusName: string): Promise<void> {
  const status = await prisma.onboardingStatus.findUniqueOrThrow({ where: { name: statusName } });
  await prisma.user.update({ where: { email }, data: { onboardingStatusId: status.id } });
}

async function createProSubscription(
  email: string,
  billingCycle: 'monthly' | 'yearly',
  opts: {
    status?: 'active' | 'cancelled' | 'expired';
    scheduledPlan?: 'free' | 'pro';
    scheduledBillingCycle?: 'monthly' | 'yearly';
  } = {},
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: billingCycle } });
  const statusRow = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: opts.status ?? 'active' } });

  let scheduledPlanId: number | undefined;
  let scheduledBillingCycleId: number | undefined;

  if (opts.scheduledPlan) {
    const sp = await prisma.plan.findUniqueOrThrow({ where: { name: opts.scheduledPlan } });
    scheduledPlanId = sp.id;
  }
  if (opts.scheduledBillingCycle) {
    const sc = await prisma.billingCycle.findUniqueOrThrow({ where: { name: opts.scheduledBillingCycle } });
    scheduledBillingCycleId = sc.id;
  }

  await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: statusRow.id,
      stripeCustomerId: 'cus_test_customer',
      stripeSubscriptionId: 'sub_test_subscription',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      ...(scheduledPlanId !== undefined && { scheduledPlanId }),
      ...(scheduledBillingCycleId !== undefined && { scheduledBillingCycleId }),
    },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateSession.mockResolvedValue({ url: 'https://checkout.stripe.com/test-session-url' });
  mockRefundsCreate.mockResolvedValue({ id: 're_test_refund_id', status: 'succeeded' });
  mockSubscriptionsRetrieve.mockResolvedValue({
    items: { data: [{ id: 'si_test_item_id' }] },
    current_period_end: 1751356800,   // ~2025-07-01 UTC (Unix timestamp)
    current_period_start: 1748678400, // ~2025-06-01 UTC
  });
  mockSubscriptionsUpdate.mockResolvedValue({
    current_period_end: 1782892800,   // ~2026-07-01 UTC (after yearly switch)
    current_period_start: 1751356800,
    cancel_at_period_end: false,
  });
  mockSubscriptionSchedulesCreate.mockResolvedValue({ id: 'sub_sched_test_id' });
  mockSubscriptionSchedulesUpdate.mockResolvedValue({ id: 'sub_sched_test_id' });
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 51. POST /subscriptions { plan: 'free' } as verified user — 201
// ---------------------------------------------------------------------------

it('51: POST /subscriptions free as verified user → 201, subscription created, onboarding complete, Stripe not called', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('', { plan: 'free' }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.plan).toBe('free');
  expect(json.data.subscription.billingCycle).toBeNull();
  expect(json.data.subscription.status).toBe('active');
  expect(json.data.subscription.stripeCustomerId).toBeNull();
  expect(json.data.subscription.stripeSubscriptionId).toBeNull();
  expect(json.data.subscription.userId).toBeDefined();
  expect(json.data.subscription.id).toBeDefined();

  // DB assertions
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: TEST_EMAIL },
    include: {
      onboardingStatus: true,
      subscription: { include: { plan: true, billingCycle: true, status: true } },
    },
  });
  expect(user.onboardingStatus.name).toBe('complete');
  expect(user.subscription).not.toBeNull();
  expect(user.subscription!.plan.name).toBe('free');
  expect(user.subscription!.billingCycleId).toBeNull();
  expect(user.subscription!.status.name).toBe('active');

  expect(mockCreateSession).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 52. POST /subscriptions { plan: 'pro', billingCycle: 'monthly' } — 200
// ---------------------------------------------------------------------------

it('52: POST /subscriptions pro monthly → 200, checkoutUrl returned, Stripe called with monthly price, no subscription row', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'pro', billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { checkoutUrl: string } };
  expect(json.data.checkoutUrl).toBe('https://checkout.stripe.com/test-session-url');

  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(mockCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: config.STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 }],
      metadata: expect.objectContaining({
        userId: String(user.id),
        plan: 'pro',
        billingCycle: 'monthly',
      }),
    }),
  );

  // No subscription row created
  const subCount = await prisma.subscription.count();
  expect(subCount).toBe(0);

  // Onboarding status unchanged
  const userWithStatus = await prisma.user.findUniqueOrThrow({
    where: { email: TEST_EMAIL },
    include: { onboardingStatus: true },
  });
  expect(userWithStatus.onboardingStatus.name).toBe('verified');
});

// ---------------------------------------------------------------------------
// 53. POST /subscriptions { plan: 'pro', billingCycle: 'yearly' }
// ---------------------------------------------------------------------------

it('53: POST /subscriptions pro yearly → Stripe called with yearly price and billingCycle: yearly', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'pro', billingCycle: 'yearly' }, cookies);
  expect(res.status).toBe(200);

  expect(mockCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      line_items: [{ price: config.STRIPE_PRO_YEARLY_PRICE_ID, quantity: 1 }],
      metadata: expect.objectContaining({ billingCycle: 'yearly' }),
    }),
  );
});

// ---------------------------------------------------------------------------
// 53a. POST /subscriptions pro with returnPath — success_url/cancel_url reflect it
// ---------------------------------------------------------------------------

it('53a: POST /subscriptions pro with returnPath → success_url/cancel_url use that path', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('', { plan: 'pro', billingCycle: 'monthly', returnPath: '/payments' }, cookies);
  expect(res.status).toBe(200);

  expect(mockCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      success_url: `${config.APP_BASE_URL}/payments?subscription=activated`,
      cancel_url: `${config.APP_BASE_URL}/payments?subscription=cancelled`,
    }),
  );
});

// ---------------------------------------------------------------------------
// 53b. POST /subscriptions pro without returnPath — defaults to /dashboard
// ---------------------------------------------------------------------------

it('53b: POST /subscriptions pro without returnPath → success_url/cancel_url default to /dashboard', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('', { plan: 'pro', billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(200);

  expect(mockCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      success_url: `${config.APP_BASE_URL}/dashboard?subscription=activated`,
      cancel_url: `${config.APP_BASE_URL}/dashboard?subscription=cancelled`,
    }),
  );
});

// ---------------------------------------------------------------------------
// 53c. POST /subscriptions pro with invalid returnPath — 400, Stripe not called
// ---------------------------------------------------------------------------

it('53c: POST /subscriptions pro with invalid returnPath → 400 VALIDATION_ERROR, Stripe NOT called', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('', { plan: 'pro', billingCycle: 'monthly', returnPath: '/evil' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');

  expect(mockCreateSession).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 54. POST /subscriptions as pending_verification user — 403
// ---------------------------------------------------------------------------

it('54: POST /subscriptions as pending_verification user → 403 EMAIL_NOT_VERIFIED', async () => {
  await registerUser(); // status: pending_verification
  const cookies = await loginUser();

  const res = await post('', { plan: 'free' }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('EMAIL_NOT_VERIFIED');

  const subCount = await prisma.subscription.count();
  expect(subCount).toBe(0);

  const user = await prisma.user.findUniqueOrThrow({
    where: { email: TEST_EMAIL },
    include: { onboardingStatus: true },
  });
  expect(user.onboardingStatus.name).toBe('pending_verification');
});

// ---------------------------------------------------------------------------
// 55. POST /subscriptions when user already has a subscription — 409
// ---------------------------------------------------------------------------

it('55: POST /subscriptions when subscription already exists → 409 SUBSCRIPTION_ALREADY_ACTIVATED, only one row', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  // First activation succeeds
  const first = await post('',{ plan: 'free' }, cookies);
  expect(first.status).toBe(201);

  // Second attempt → 409 (status is now 'complete')
  const second = await post('',{ plan: 'free' }, cookies);
  expect(second.status).toBe(409);

  const json = await second.json() as { error: { code: string } };
  expect(json.error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVATED');

  const subCount = await prisma.subscription.count();
  expect(subCount).toBe(1);
});

// ---------------------------------------------------------------------------
// 56. POST /subscriptions pro when status 'complete' — 409, Stripe not called
// ---------------------------------------------------------------------------

it('56: POST /subscriptions pro when onboarding complete → 409, Stripe NOT called', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'complete');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'pro', billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVATED');

  expect(mockCreateSession).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 57. POST /subscriptions pro without billingCycle — 400
// ---------------------------------------------------------------------------

it('57: POST /subscriptions pro without billingCycle → 400 VALIDATION_ERROR', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'pro' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 58. POST /subscriptions free with billingCycle — 400
// ---------------------------------------------------------------------------

it('58: POST /subscriptions free with billingCycle → 400 VALIDATION_ERROR (billingCycle forbidden)', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'free', billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 59. POST /subscriptions invalid plan — 400
// ---------------------------------------------------------------------------

it('59: POST /subscriptions invalid plan → 400 VALIDATION_ERROR', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'enterprise' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 60. POST /subscriptions unknown field — 400 (strict schema)
// ---------------------------------------------------------------------------

it('60: POST /subscriptions unknown field in body → 400 VALIDATION_ERROR', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await post('',{ plan: 'free', unknownField: 'oops' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 61. POST /subscriptions without auth — 401
// ---------------------------------------------------------------------------

it('61: POST /subscriptions without auth → 401 UNAUTHENTICATED', async () => {
  const res = await post('',{ plan: 'free' });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 62. GET /subscriptions/me when subscription exists — 200
// ---------------------------------------------------------------------------

it('62: GET /subscriptions/me when subscription exists → 200 with DTO', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  // Activate free subscription first
  await post('',{ plan: 'free' }, cookies);

  const res = await get('/me', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.plan).toBe('free');
  expect(json.data.subscription.status).toBe('active');
  expect(json.data.subscription.billingCycle).toBeNull();

  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(json.data.subscription.userId).toBe(user.id);
});

// ---------------------------------------------------------------------------
// 63. GET /subscriptions/me when no subscription exists — 404
// ---------------------------------------------------------------------------

it('63: GET /subscriptions/me when no subscription → 404 SUBSCRIPTION_NOT_FOUND', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();

  const res = await get('/me', cookies);
  expect(res.status).toBe(404);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 64. GET /subscriptions/me without auth — 401
// ---------------------------------------------------------------------------

it('64: GET /subscriptions/me without auth → 401 UNAUTHENTICATED', async () => {
  const res = await get('/me');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 65. POST /subscriptions/upgrade — free → pro monthly → 200 checkoutUrl
// ---------------------------------------------------------------------------
