// Neonfi backend — Subscriptions module: route controller (Stage 3A/3B).
//
// Mounted at /api/v1/subscriptions by src/app.ts.
//
// Endpoints:
//   POST /subscriptions           — initial activation (free: immediate; pro: Stripe checkout)
//   GET  /subscriptions/me        — read own subscription
//   POST /subscriptions/upgrade   — upgrade plan or billing cycle
//   POST /subscriptions/downgrade — schedule downgrade (deferred)
//   POST /subscriptions/cancel    — cancel at period end

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import {
  SubscriptionError,
  activateSubscription,
  getMySubscription,
  upgradeSubscription,
  downgradeSubscription,
  cancelSubscription,
  refundSubscription,
} from './subscriptions.service.js';
import {
  CreateSubscriptionSchema,
  UpgradeSubscriptionSchema,
  DowngradeSubscriptionSchema,
  RefundSubscriptionSchema,
} from './subscriptions.schemas.js';

const router = new Hono<AuthEnv>();

function handleError(e: unknown, c: { json(body: unknown, status?: number): Response }): Response {
  if (e instanceof SubscriptionError) {
    if (e.meta) {
      return c.json({ ...err(e.code, e.message), meta: e.meta }, e.statusCode);
    }
    return c.json(err(e.code, e.message), e.statusCode);
  }
  throw e;
}

function parseBody(schema: typeof CreateSubscriptionSchema | typeof UpgradeSubscriptionSchema | typeof DowngradeSubscriptionSchema) {
  return async (rawBody: unknown) => {
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { error: issue?.message ?? 'Validation failed', data: null };
    }
    return { error: null, data: parsed.data };
  };
}

// ---------------------------------------------------------------------------
// POST /subscriptions — initial activation
// ---------------------------------------------------------------------------

router.post('', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(err('VALIDATION_ERROR', 'Request body must be valid JSON'), 400);
  }

  const parsed = CreateSubscriptionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  try {
    const user = c.get('user');
    const result = await activateSubscription(user, parsed.data);
    if ('subscription' in result) {
      return c.json(ok(result), 201);
    }
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// GET /subscriptions/me — read own subscription
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    const result = await getMySubscription(user.id);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /subscriptions/upgrade
// ---------------------------------------------------------------------------

router.post('/upgrade', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(err('VALIDATION_ERROR', 'Request body must be valid JSON'), 400);
  }

  const parsed = UpgradeSubscriptionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  try {
    const user = c.get('user');
    const result = await upgradeSubscription(user, parsed.data);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /subscriptions/downgrade
// ---------------------------------------------------------------------------

router.post('/downgrade', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = DowngradeSubscriptionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  try {
    const user = c.get('user');
    const result = await downgradeSubscription(user, parsed.data);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /subscriptions/cancel
// ---------------------------------------------------------------------------

router.post('/cancel', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    const result = await cancelSubscription(user);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /subscriptions/refund — request refund of most recent payment
// ---------------------------------------------------------------------------

router.post('/refund', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = RefundSubscriptionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  try {
    const user = c.get('user');
    const result = await refundSubscription(user, parsed.data);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

export { router as subscriptionsRouter };
