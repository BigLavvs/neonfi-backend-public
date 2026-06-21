// Neonfi backend — Subscriptions module integration tests (Stage 3A).
//
// Strategy: same as auth/users — dev DB + Redis, per-test truncation.
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

it('65: upgrade free → pro monthly → 200 checkoutUrl, Stripe checkout called, DB unchanged', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();
  // Activate free subscription first
  await post('', { plan: 'free' }, cookies);

  const res = await post('/upgrade', { billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { checkoutUrl: string } };
  expect(json.data.checkoutUrl).toBe('https://checkout.stripe.com/test-session-url');

  // Verify Stripe checkout was called with monthly price
  expect(mockCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: config.STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 }],
    }),
  );

  // DB subscription still shows 'free' (no webhook yet)
  const sub = await prisma.subscription.findFirst({ include: { plan: true } });
  expect(sub!.plan.name).toBe('free');
});

// ---------------------------------------------------------------------------
// 66. POST /subscriptions/upgrade — pro monthly → pro yearly → 200 SubscriptionDTO
// ---------------------------------------------------------------------------

it('66: upgrade pro monthly → pro yearly → 200, retrieve+update called, DB billingCycle updated', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'monthly');

  const res = await post('/upgrade', { billingCycle: 'yearly' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.billingCycle).toBe('yearly');
  expect(json.data.subscription.status).toBe('active');
  expect(json.data.subscription.scheduledPlan).toBeNull();
  expect(json.data.subscription.scheduledBillingCycle).toBeNull();

  expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_test_subscription');
  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
    'sub_test_subscription',
    expect.objectContaining({
      items: [{ id: 'si_test_item_id', price: config.STRIPE_PRO_YEARLY_PRICE_ID }],
      proration_behavior: 'create_prorations',
    }),
  );

  // DB should reflect the updated billing cycle
  const sub = await prisma.subscription.findFirst({ include: { billingCycle: true } });
  expect(sub!.billingCycle!.name).toBe('yearly');
});

// ---------------------------------------------------------------------------
// 67. POST /subscriptions/upgrade — pro yearly → pro monthly → 400 INVALID_UPGRADE
// ---------------------------------------------------------------------------

it('67: upgrade pro yearly → monthly → 400 INVALID_UPGRADE', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'yearly');

  const res = await post('/upgrade', { billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_UPGRADE');
});

// ---------------------------------------------------------------------------
// 68. POST /subscriptions/upgrade — pro yearly → pro yearly (no-op) → 400
// ---------------------------------------------------------------------------

it('68: upgrade pro yearly → yearly (no-op) → 400 NO_CHANGE_TO_APPLY', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'yearly');

  const res = await post('/upgrade', { billingCycle: 'yearly' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NO_CHANGE_TO_APPLY');
});

// ---------------------------------------------------------------------------
// 69. POST /subscriptions/upgrade — pro yearly with pending cancellation → reactivates
// ---------------------------------------------------------------------------

it('69: upgrade pro yearly with cancellation pending → 200, status reverts to active', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'yearly', { status: 'cancelled' });

  const res = await post('/upgrade', { billingCycle: 'yearly' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.status).toBe('active');

  // Stripe was called to clear cancel_at_period_end
  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
    'sub_test_subscription',
    expect.objectContaining({ cancel_at_period_end: false }),
  );

  // DB status updated to active
  const sub = await prisma.subscription.findFirst({ include: { status: true } });
  expect(sub!.status.name).toBe('active');
});

// ---------------------------------------------------------------------------
// 70. POST /subscriptions/upgrade — no subscription → 409
// ---------------------------------------------------------------------------

it('70: upgrade with no subscription → 409 NO_SUBSCRIPTION_TO_UPGRADE', async () => {
  await registerUser();
  const cookies = await loginUser();

  const res = await post('/upgrade', { billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NO_SUBSCRIPTION_TO_UPGRADE');
});

// ---------------------------------------------------------------------------
// 71. POST /subscriptions/downgrade — pro monthly → free → 200
// ---------------------------------------------------------------------------

it('71: downgrade pro monthly → free → 200, Stripe cancel_at_period_end set, scheduledPlanId updated', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'monthly');

  const res = await post('/downgrade', { plan: 'free' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.scheduledPlan).toBe('free');
  expect(json.data.subscription.status).toBe('active'); // still active until period end

  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
    'sub_test_subscription',
    expect.objectContaining({ cancel_at_period_end: true }),
  );

  // DB: scheduledPlanId set to free plan row
  const sub = await prisma.subscription.findFirst({ include: { scheduledPlan: true } });
  expect(sub!.scheduledPlan!.name).toBe('free');
});

// ---------------------------------------------------------------------------
// 72. POST /subscriptions/downgrade — pro yearly → monthly → 200 (schedule created)
// ---------------------------------------------------------------------------

it('72: downgrade pro yearly → monthly → 200, schedule created, scheduledBillingCycleId set', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'yearly');

  const res = await post('/downgrade', { billingCycle: 'monthly' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.scheduledBillingCycle).toBe('monthly');
  expect(json.data.subscription.plan).toBe('pro');

  expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_test_subscription');
  expect(mockSubscriptionSchedulesCreate).toHaveBeenCalledWith({ from_subscription: 'sub_test_subscription' });
  expect(mockSubscriptionSchedulesUpdate).toHaveBeenCalledWith(
    'sub_sched_test_id',
    expect.objectContaining({
      phases: expect.arrayContaining([
        expect.objectContaining({ items: [{ price: config.STRIPE_PRO_YEARLY_PRICE_ID, quantity: 1 }] }),
        expect.objectContaining({ items: [{ price: config.STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 }] }),
      ]),
    }),
  );

  // DB: scheduledBillingCycleId set to monthly row; plan unchanged
  const sub = await prisma.subscription.findFirst({ include: { plan: true, scheduledBillingCycle: true } });
  expect(sub!.plan.name).toBe('pro');
  expect(sub!.scheduledBillingCycle!.name).toBe('monthly');
});

// ---------------------------------------------------------------------------
// 73. POST /subscriptions/downgrade — from free → 400
// ---------------------------------------------------------------------------

it('73: downgrade from free plan → 400 CANNOT_DOWNGRADE_FROM_FREE', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();
  // Activate free subscription
  await post('', { plan: 'free' }, cookies);

  const res = await post('/downgrade', { plan: 'free' }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CANNOT_DOWNGRADE_FROM_FREE');
});

// ---------------------------------------------------------------------------
// 74. POST /subscriptions/downgrade — no subscription → 409
// ---------------------------------------------------------------------------

it('74: downgrade with no subscription → 409 NO_SUBSCRIPTION_TO_DOWNGRADE', async () => {
  await registerUser();
  const cookies = await loginUser();

  const res = await post('/downgrade', { plan: 'free' }, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NO_SUBSCRIPTION_TO_DOWNGRADE');
});

// ---------------------------------------------------------------------------
// 75. POST /subscriptions/downgrade — downgrade already scheduled → 409
// ---------------------------------------------------------------------------

it('75: downgrade with scheduled change already pending → 409 DOWNGRADE_ALREADY_SCHEDULED', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'monthly', { scheduledPlan: 'free' });

  const res = await post('/downgrade', { plan: 'free' }, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('DOWNGRADE_ALREADY_SCHEDULED');
});

// ---------------------------------------------------------------------------
// 76. POST /subscriptions/cancel — active pro → 200, status becomes cancelled
// ---------------------------------------------------------------------------

it('76: cancel active pro → 200, Stripe cancel_at_period_end set, DB status cancelled', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'monthly');

  const res = await post('/cancel', {}, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.status).toBe('cancelled');

  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
    'sub_test_subscription',
    expect.objectContaining({ cancel_at_period_end: true }),
  );

  // DB: status set to cancelled, currentPeriodEnd unchanged
  const sub = await prisma.subscription.findFirst({ include: { status: true } });
  expect(sub!.status.name).toBe('cancelled');
  expect(sub!.currentPeriodEnd?.toISOString().startsWith('2026-07-01')).toBe(true);
});

// ---------------------------------------------------------------------------
// 77. POST /subscriptions/cancel — already cancelled (idempotent) → 200, no Stripe call
// ---------------------------------------------------------------------------

it('77: cancel already-cancelled pro → 200 idempotent, Stripe NOT called again', async () => {
  await registerUser();
  const cookies = await loginUser();
  await createProSubscription(TEST_EMAIL, 'monthly', { status: 'cancelled' });

  const res = await post('/cancel', {}, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { subscription: Record<string, unknown> } };
  expect(json.data.subscription.status).toBe('cancelled');

  expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 78. POST /subscriptions/cancel — free plan → 400
// ---------------------------------------------------------------------------

it('78: cancel free subscription → 400 CANNOT_CANCEL_FREE', async () => {
  await registerUser();
  await setOnboardingStatus(TEST_EMAIL, 'verified');
  const cookies = await loginUser();
  // Activate free subscription
  await post('', { plan: 'free' }, cookies);

  const res = await post('/cancel', {}, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('CANNOT_CANCEL_FREE');
});

// ---------------------------------------------------------------------------
// Refund tests helpers
// ---------------------------------------------------------------------------

async function createProSubDirectly(email: string): Promise<{ userId: number; subscriptionId: number }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const statusRow = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  const sub = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: statusRow.id,
      stripeCustomerId: 'cus_test_refund',
      stripeSubscriptionId: 'sub_test_refund',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });
  return { userId: user.id, subscriptionId: sub.id };
}

// ---------------------------------------------------------------------------
// 109. POST /subscriptions/refund — eligible succeeded payment within 3 days
// ---------------------------------------------------------------------------

it('109: POST /subscriptions/refund — eligible payment → 200, Stripe refund (idempotency key), refundAvailable flipped false, Pro revoked at period end (audit decision 2)', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  const payment = await seedPayment({
    userId,
    subscriptionId,
    status: 'succeeded',
    refundAvailable: true,
  });

  const res = await post('/refund', { reason: 'I changed my mind' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { refundRequested: boolean; paymentId: number } };
  expect(json.data.refundRequested).toBe(true);
  expect(json.data.paymentId).toBe(payment.id);

  // Stripe refund called with the per-payment idempotency key (no double-refund on retry).
  expect(mockRefundsCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      payment_intent: payment.stripePaymentIntentId,
      reason: 'requested_by_customer',
      metadata: { user_reason: 'I changed my mind' },
    }),
    expect.objectContaining({ idempotencyKey: `refund:${payment.id}` }),
  );

  // refundAvailable flipped to false (set BEFORE the Stripe call). Status stays 'succeeded' in
  // this unit context — the real charge.refunded webhook flips it to 'refunded'.
  const dbPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
    include: { status: true },
  });
  expect(dbPayment.status.name).toBe('succeeded');
  expect(dbPayment.refundAvailable).toBe(false);

  // Pro revoked AT PERIOD END: Stripe sub set to cancel_at_period_end + local downgrade to Free
  // scheduled (the user keeps Pro until the period ends).
  expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test_refund', { cancel_at_period_end: true });
  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const dbSub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  expect(dbSub.scheduledPlanId).toBe(freePlan.id);
});

// ---------------------------------------------------------------------------
// 109b. Concurrency: a refund already in progress (lock held) → 409 REFUND_IN_PROGRESS
// ---------------------------------------------------------------------------

it('109b: POST /subscriptions/refund — refund already in progress (Redis lock held) → 409 REFUND_IN_PROGRESS; Stripe NOT called', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);
  const payment = await seedPayment({ userId, subscriptionId, status: 'succeeded', refundAvailable: true });

  // Simulate a concurrent refund holding the per-payment lock.
  await redis.set(`refund:${payment.id}`, '1', 'EX', 120, 'NX');

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(409);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('REFUND_IN_PROGRESS');
  expect(mockRefundsCreate).not.toHaveBeenCalled();
  // refundAvailable untouched (still true) since we never started.
  const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(dbPayment.refundAvailable).toBe(true);

  await redis.del(`refund:${payment.id}`);
});

// ---------------------------------------------------------------------------
// 109c. Stripe refund fails → 400 REFUND_FAILED; refundAvailable RESTORED; lock released
// ---------------------------------------------------------------------------

it('109c: POST /subscriptions/refund — Stripe refund fails → 400 REFUND_FAILED, refundAvailable restored, lock released (retry-safe)', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);
  const payment = await seedPayment({ userId, subscriptionId, status: 'succeeded', refundAvailable: true });

  mockRefundsCreate.mockRejectedValueOnce(Object.assign(new Error('card_error'), { code: 'charge_already_refunded' }));

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('REFUND_FAILED');

  // Flag restored so a legitimate retry can succeed; lock released.
  const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(dbPayment.refundAvailable).toBe(true);
  expect(await redis.get(`refund:${payment.id}`)).toBeNull();
});

// ---------------------------------------------------------------------------
// 110. POST /subscriptions/refund — no reason
// ---------------------------------------------------------------------------

it('110: POST /subscriptions/refund — no reason → 200, Stripe called without reason or metadata', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  await seedPayment({ userId, subscriptionId, status: 'succeeded', refundAvailable: true });

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { refundRequested: boolean } };
  expect(json.data.refundRequested).toBe(true);

  // Called without reason and without metadata.user_reason (second arg is the idempotency key).
  expect(mockRefundsCreate).toHaveBeenCalledWith(
    expect.not.objectContaining({ reason: expect.anything() }),
    expect.anything(),
  );
  const callArg = mockRefundsCreate.mock.calls[0]![0] as Record<string, unknown>;
  expect(callArg.reason).toBeUndefined();
  expect((callArg.metadata as Record<string, unknown> | undefined)?.user_reason).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 111. POST /subscriptions/refund — payment >3 days old → 400 REFUND_NOT_ELIGIBLE
// ---------------------------------------------------------------------------

it('111: POST /subscriptions/refund — payment >3 days old → 400 REFUND_NOT_ELIGIBLE; Stripe NOT called', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  await seedPayment({
    userId,
    subscriptionId,
    status: 'succeeded',
    refundAvailable: true,
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), // 4 days ago
  });

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('REFUND_NOT_ELIGIBLE');
  expect(mockRefundsCreate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 112. POST /subscriptions/refund — payment.refundAvailable=false → 400
// ---------------------------------------------------------------------------

it('112: POST /subscriptions/refund — refundAvailable=false → 400 REFUND_NOT_ELIGIBLE; Stripe NOT called', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  await seedPayment({
    userId,
    subscriptionId,
    status: 'succeeded',
    refundAvailable: false,
  });

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('REFUND_NOT_ELIGIBLE');
  expect(mockRefundsCreate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 113. POST /subscriptions/refund — no successful payments → 409
// ---------------------------------------------------------------------------

it('113: POST /subscriptions/refund — no successful payments → 409 NO_PAYMENT_TO_REFUND', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  // Only failed and pending payments
  await seedPayment({ userId, subscriptionId, status: 'failed' });
  await seedPayment({ userId, subscriptionId, status: 'pending' });

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NO_PAYMENT_TO_REFUND');
  expect(mockRefundsCreate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 114. POST /subscriptions/refund — no subscription → 409
// ---------------------------------------------------------------------------

it('114: POST /subscriptions/refund — no subscription → 409 NO_SUBSCRIPTION_TO_REFUND', async () => {
  await registerUser();
  const cookies = await loginUser();

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(409);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NO_SUBSCRIPTION_TO_REFUND');
  expect(mockRefundsCreate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 115. POST /subscriptions/refund — Stripe throws → 400 REFUND_FAILED with meta.stripeCode
// ---------------------------------------------------------------------------

it('115: POST /subscriptions/refund — Stripe throws → 400 REFUND_FAILED with meta.stripeCode; no DB writes', async () => {
  await registerUser();
  const cookies = await loginUser();
  const { userId, subscriptionId } = await createProSubDirectly(TEST_EMAIL);

  const payment = await seedPayment({
    userId,
    subscriptionId,
    status: 'succeeded',
    refundAvailable: true,
  });

  const stripeError = Object.assign(new Error('Stripe error'), { code: 'card_error' });
  mockRefundsCreate.mockRejectedValueOnce(stripeError);

  const res = await post('/refund', {}, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string }; meta: { stripeCode: string } };
  expect(json.error.code).toBe('REFUND_FAILED');
  expect(json.meta.stripeCode).toBe('card_error');

  // Payment row NOT mutated
  const dbPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
    include: { status: true },
  });
  expect(dbPayment.status.name).toBe('succeeded');
  expect(dbPayment.refundAvailable).toBe(true);
});
