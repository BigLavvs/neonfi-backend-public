// Neonfi backend — Webhooks controller (Stage 4A).
//
// No auth middleware — Stripe is the caller; verification is signature-based.
// Raw body must be read via c.req.text() BEFORE any JSON parsing.

import { Hono } from 'hono';
import { err } from '../../lib/envelope.js';
import { processWebhookEvent } from './webhooks.service.js';

export const webhooksRouter = new Hono();

webhooksRouter.post('/stripe', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature');

  if (!signature) {
    return c.json(err('INVALID_SIGNATURE', 'Webhook signature verification failed'), 401);
  }

  const result = await processWebhookEvent(rawBody, signature);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(result.body, result.status as any);
});
