// Neonfi backend — Webhooks integration tests (Stage 4A).
//
// Strategy: real DB + Redis with per-test cleanup.
// Stripe webhooks.constructEvent and subscriptions.retrieve are mocked.
// Email module mocked — no real Resend calls.
// Tests numbered 86–98 (continuing from Stage 3B's 85).

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------

const { mockConstructEvent, mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
}));

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Stripe as any).errors = {
    StripeSignatureVerificationError: class extends Error {},
  };
  return { default: Stripe };
});

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
// Constants
// ---------------------------------------------------------------------------

const WEBHOOKS_BASE = '/api/v1/webhooks';
const STRIPE_SUB_ID = 'sub_test_webhook_sub';
const STRIPE_CUST_ID = 'cus_test_webhook_cust';
const STRIPE_PI_ID = 'pi_test_webhook_pi';
const TEST_EMAIL = 'webhooks.integration@neonfi.test';
const TEST_FULL_NAME = 'Webhooks Integration';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function webhookPost(eventPayload: object, signature = 'whsec_test'): Promise<Response> {
  return app.request(`${WEBHOOKS_BASE}/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body: JSON.stringify(eventPayload),
  });
}

function makeEvent(type: string, data: object, id = 'evt_test_001'): object {
  return { id, type, data: { object: data } };
}

async function createUser(onboardingStatusName = 'verified'): Promise<number> {
  const authProvider = await prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } });
  const onboardingStatus = await prisma.onboardingStatus.findUniqueOrThrow({ where: { name: onboardingStatusName } });
  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      fullName: TEST_FULL_NAME,
      authProviderId: authProvider.id,
      onboardingStatusId: onboardingStatus.id,
    },
  });
  return user.id;
}

async function createFreeSubscription(userId: number): Promise<number> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  const sub = await prisma.subscription.create({
    data: { userId, planId: plan.id, billingCycleId: null, statusId: status.id },
  });
  return sub.id;
}

async function createProSubscription(
  userId: number,
  opts: {
    billingCycle?: 'monthly' | 'yearly';
    status?: 'active' | 'cancelled' | 'expired';
    scheduledPlan?: 'free' | null;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
  } = {},
): Promise<number> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: opts.billingCycle ?? 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: opts.status ?? 'active' } });

  let scheduledPlanId: number | undefined;
  if (opts.scheduledPlan === 'free') {
    const fp = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
    scheduledPlanId = fp.id;
  }

  const sub = await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      stripeCustomerId: opts.stripeCustomerId ?? STRIPE_CUST_ID,
      stripeSubscriptionId: opts.stripeSubscriptionId ?? STRIPE_SUB_ID,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      ...(scheduledPlanId !== undefined && { scheduledPlanId }),
    },
  });
  return sub.id;
}

async function createPayment(subscriptionId: number, userId: number, piId = STRIPE_PI_ID): Promise<number> {
  const status = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: 'succeeded' } });
  const payment = await prisma.payment.create({
    data: {
      userId,
      subscriptionId,
      stripePaymentIntentId: piId,
      amount: 999,
      currency: 'usd',
      statusId: status.id,
      refundAvailable: true,
    },
  });
  return payment.id;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  mockSubscriptionsRetrieve.mockResolvedValue({
    current_period_start: 1748678400,
    current_period_end: 1751356800,
  });
  await truncateAllUserData();
  await clearRedisAuthKeys();
  const stripeKeys = await redis.keys('stripe_event:*');
  if (stripeKeys.length > 0) await redis.del(stripeKeys as string[]);
});

// ---------------------------------------------------------------------------
// 86. Valid signature → 200 received: true
// ---------------------------------------------------------------------------

it('86: valid sig → 200 { received: true }', async () => {
  // invoice.payment_failed with non-existent subscription: handler returns early, no error
  const event = makeEvent('invoice.payment_failed', {
    subscription: 'sub_nonexistent',
    payment_intent: null,
    amount_due: 999,
    currency: 'usd',
    next_payment_attempt: null,
  });
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { received: boolean } };
  expect(json.data.received).toBe(true);
});

// ---------------------------------------------------------------------------
// 87. Invalid signature → 401 INVALID_SIGNATURE; no DB writes; no Redis key
// ---------------------------------------------------------------------------

it('87: invalid sig → 401 INVALID_SIGNATURE; no DB writes; no Redis key set', async () => {
  mockConstructEvent.mockImplementationOnce(() => {
    throw new Error('Stripe signature verification failed');
  });

  const res = await webhookPost({ type: 'test' });
  expect(res.status).toBe(401);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_SIGNATURE');

  const keys = await redis.keys('stripe_event:*');
  expect(keys.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 88. Missing signature header → 401 INVALID_SIGNATURE
// ---------------------------------------------------------------------------

it('88: missing stripe-signature header → 401 INVALID_SIGNATURE', async () => {
  const res = await app.request(`${WEBHOOKS_BASE}/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'test' }),
  });
  expect(res.status).toBe(401);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_SIGNATURE');
});

// ---------------------------------------------------------------------------
// 89. Same event ID twice → second returns duplicate: true; only one Payment row
// ---------------------------------------------------------------------------

it('89: idempotency — same event ID twice → second returns duplicate: true; only one Payment row', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId);

  const event = makeEvent('invoice.payment_succeeded', {
    subscription: STRIPE_SUB_ID,
    payment_intent: 'pi_idempotency_test',
    amount_paid: 999,
    currency: 'usd',
    period_start: 1748678400,
    period_end: 1751356800,
  }, 'evt_idempotency_001');

  mockConstructEvent.mockReturnValue(event);

  const res1 = await webhookPost(event);
  expect(res1.status).toBe(200);
  const json1 = await res1.json() as { data: { received: boolean; duplicate?: boolean } };
  expect(json1.data.received).toBe(true);
  expect(json1.data.duplicate).toBeUndefined();

  const res2 = await webhookPost(event);
  expect(res2.status).toBe(200);
  const json2 = await res2.json() as { data: { received: boolean; duplicate?: boolean } };
  expect(json2.data.received).toBe(true);
  expect(json2.data.duplicate).toBe(true);

  const payments = await prisma.payment.findMany({ where: { subscriptionId: subId } });
  expect(payments.length).toBe(1);
});

// ---------------------------------------------------------------------------
// 90. checkout.session.completed — new Pro user (Stage 3A path)
// ---------------------------------------------------------------------------

it('90: checkout.session.completed new Pro user → Subscription created, Payment created, onboarding complete', async () => {
  const userId = await createUser('verified');

  const event = makeEvent('checkout.session.completed', {
    payment_intent: STRIPE_PI_ID,
    subscription: STRIPE_SUB_ID,
    customer: STRIPE_CUST_ID,
    amount_total: 999,
    currency: 'usd',
    payment_status: 'paid',
    metadata: { userId: String(userId), plan: 'pro', billingCycle: 'monthly' },
  });
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true, billingCycle: true, status: true },
  });
  expect(sub).not.toBeNull();
  expect(sub!.plan.name).toBe('pro');
  expect(sub!.billingCycle?.name).toBe('monthly');
  expect(sub!.status.name).toBe('active');
  expect(sub!.stripeCustomerId).toBe(STRIPE_CUST_ID);
  expect(sub!.stripeSubscriptionId).toBe(STRIPE_SUB_ID);
  expect(sub!.currentPeriodStart).not.toBeNull();
  expect(sub!.currentPeriodEnd).not.toBeNull();

  const payment = await prisma.payment.findFirst({ where: { stripePaymentIntentId: STRIPE_PI_ID } });
  expect(payment).not.toBeNull();
  expect(payment!.amount).toBe(999);
  expect(payment!.currency).toBe('usd');

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { onboardingStatus: true },
  });
  expect(user.onboardingStatus.name).toBe('complete');

  expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(STRIPE_SUB_ID);
});

// ---------------------------------------------------------------------------
// 91. checkout.session.completed — free→pro upgrade (Stage 3B path)
// ---------------------------------------------------------------------------

it('91: checkout.session.completed free→pro upgrade → Subscription updated to pro, Payment created, onboarding unchanged', async () => {
  const userId = await createUser('complete');
  await createFreeSubscription(userId);

  const event = makeEvent('checkout.session.completed', {
    payment_intent: STRIPE_PI_ID,
    subscription: STRIPE_SUB_ID,
    customer: STRIPE_CUST_ID,
    amount_total: 999,
    currency: 'usd',
    payment_status: 'paid',
    metadata: { userId: String(userId), plan: 'pro', billingCycle: 'yearly' },
  }, 'evt_upgrade_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true, billingCycle: true, status: true },
  });
  expect(sub!.plan.name).toBe('pro');
  expect(sub!.billingCycle?.name).toBe('yearly');
  expect(sub!.status.name).toBe('active');
  expect(sub!.stripeSubscriptionId).toBe(STRIPE_SUB_ID);

  const payment = await prisma.payment.findFirst({ where: { stripePaymentIntentId: STRIPE_PI_ID } });
  expect(payment).not.toBeNull();

  // Onboarding stays complete
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { onboardingStatus: true },
  });
  expect(user.onboardingStatus.name).toBe('complete');
});

// ---------------------------------------------------------------------------
// 92. invoice.payment_succeeded → Payment created; period dates updated
// ---------------------------------------------------------------------------

it('92: invoice.payment_succeeded → Payment row created, Subscription period dates updated', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId);

  const newPeriodStart = 1751356800; // 2026-07-01
  const newPeriodEnd = 1753948800;   // 2026-08-01

  const event = makeEvent('invoice.payment_succeeded', {
    subscription: STRIPE_SUB_ID,
    payment_intent: 'pi_invoice_succeeded_001',
    amount_paid: 999,
    currency: 'usd',
    period_start: newPeriodStart,
    period_end: newPeriodEnd,
  }, 'evt_invoice_succeeded_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const payment = await prisma.payment.findFirst({ where: { subscriptionId: subId } });
  expect(payment).not.toBeNull();
  expect(payment!.amount).toBe(999);
  expect(payment!.currency).toBe('usd');
  expect(payment!.stripePaymentIntentId).toBe('pi_invoice_succeeded_001');

  const sub = await prisma.subscription.findUnique({ where: { id: subId } });
  expect(sub!.currentPeriodStart?.getTime()).toBe(newPeriodStart * 1000);
  expect(sub!.currentPeriodEnd?.getTime()).toBe(newPeriodEnd * 1000);
});

// ---------------------------------------------------------------------------
// 93. invoice.payment_failed → Payment row created (failed); Subscription state unchanged
// ---------------------------------------------------------------------------

it('93: invoice.payment_failed → Payment row created with status=failed; Subscription state unchanged', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId);

  const event = makeEvent('invoice.payment_failed', {
    subscription: STRIPE_SUB_ID,
    payment_intent: 'pi_failed_001',
    amount_due: 999,
    currency: 'usd',
    next_payment_attempt: 1751443200,
  }, 'evt_invoice_failed_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const payment = await prisma.payment.findFirst({ where: { subscriptionId: subId } });
  expect(payment).not.toBeNull();
  expect(payment!.stripePaymentIntentId).toBe('pi_failed_001');

  const paymentStatus = await prisma.paymentStatus.findUniqueOrThrow({ where: { id: payment!.statusId } });
  expect(paymentStatus.name).toBe('failed');

  // Subscription status unchanged
  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    include: { status: true },
  });
  expect(sub!.status.name).toBe('active');
});

// ---------------------------------------------------------------------------
// 94. customer.subscription.updated (cancel_at_period_end=true) → local status=cancelled
// ---------------------------------------------------------------------------

it('94: customer.subscription.updated cancel_at_period_end=true → local Subscription status set to cancelled', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId);

  const event = makeEvent('customer.subscription.updated', {
    id: STRIPE_SUB_ID,
    cancel_at_period_end: true,
    current_period_start: 1748678400,
    current_period_end: 1751356800,
  }, 'evt_sub_updated_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    include: { status: true },
  });
  expect(sub!.status.name).toBe('cancelled');
});

// ---------------------------------------------------------------------------
// 95. customer.subscription.deleted — pro→free deferred downgrade path
// ---------------------------------------------------------------------------

it('95: customer.subscription.deleted with scheduledPlan=free → downgrade applied: plan=free, Stripe IDs null, status=active', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId, { scheduledPlan: 'free' });

  const event = makeEvent('customer.subscription.deleted', {
    id: STRIPE_SUB_ID,
  }, 'evt_sub_deleted_downgrade');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    include: { plan: true, status: true },
  });
  expect(sub!.plan.name).toBe('free');
  expect(sub!.status.name).toBe('active');
  expect(sub!.billingCycleId).toBeNull();
  expect(sub!.stripeCustomerId).toBeNull();
  expect(sub!.stripeSubscriptionId).toBeNull();
  expect(sub!.currentPeriodStart).toBeNull();
  expect(sub!.currentPeriodEnd).toBeNull();
  expect(sub!.scheduledPlanId).toBeNull();
  expect(sub!.scheduledBillingCycleId).toBeNull();
});

// ---------------------------------------------------------------------------
// 96. customer.subscription.deleted — pure cancellation path
// ---------------------------------------------------------------------------

it('96: customer.subscription.deleted with no scheduledPlan → status=expired; plan/billingCycle unchanged', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId, { status: 'cancelled' });

  const event = makeEvent('customer.subscription.deleted', {
    id: STRIPE_SUB_ID,
  }, 'evt_sub_deleted_expired');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    include: { plan: true, status: true },
  });
  expect(sub!.status.name).toBe('expired');
  // Plan/billingCycle kept as audit trail
  expect(sub!.plan.name).toBe('pro');
  expect(sub!.billingCycleId).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 97. charge.refunded → Payment.status=refunded; refundAvailable=false
// ---------------------------------------------------------------------------

it('97: charge.refunded → Payment status set to refunded, refundAvailable=false', async () => {
  const userId = await createUser('complete');
  const subId = await createProSubscription(userId);
  const paymentId = await createPayment(subId, userId);

  const event = makeEvent('charge.refunded', {
    payment_intent: STRIPE_PI_ID,
    amount_refunded: 999,
    currency: 'usd',
  }, 'evt_charge_refunded_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { status: true },
  });
  expect(payment!.status.name).toBe('refunded');
  expect(payment!.refundAvailable).toBe(false);
});

// ---------------------------------------------------------------------------
// 98. Unhandled event type → 200 received: true, unhandled: true; idempotency key set
// ---------------------------------------------------------------------------

it('98: unhandled event type → 200 { received: true, unhandled: true }; Redis key still set', async () => {
  const event = makeEvent('customer.created', { id: 'cus_unhandled' }, 'evt_unhandled_001');
  mockConstructEvent.mockReturnValueOnce(event);

  const res = await webhookPost(event);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { received: boolean; unhandled?: boolean } };
  expect(json.data.received).toBe(true);
  expect(json.data.unhandled).toBe(true);

  // Idempotency key still set so retries are no-ops
  const key = await redis.get('stripe_event:evt_unhandled_001');
  expect(key).toBe('1');
});
