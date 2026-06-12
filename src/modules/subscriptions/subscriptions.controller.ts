// Neonfi backend — Subscriptions module: route controller (Stage 3A).
//
// Mounted at /api/v1/subscriptions by src/app.ts.
//
// Endpoints:
//   POST /subscriptions     — initial activation (free: immediate; pro: Stripe checkout)
//   GET  /subscriptions/me  — read own subscription

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { SubscriptionError, activateSubscription, getMySubscription } from './subscriptions.service.js';
import { CreateSubscriptionSchema } from './subscriptions.schemas.js';

const router = new Hono<AuthEnv>();

function handleError(e: unknown, c: { json(body: unknown, status?: number): Response }): Response {
  if (e instanceof SubscriptionError) {
    return c.json(err(e.code, e.message), e.statusCode);
  }
  throw e;
}

// ---------------------------------------------------------------------------
// POST /subscriptions — initial activation
// ---------------------------------------------------------------------------

router.post('/', requireAuth, async (c) => {
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

export { router as subscriptionsRouter };
