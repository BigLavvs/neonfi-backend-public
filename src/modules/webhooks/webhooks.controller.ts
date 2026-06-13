// Neonfi backend — Webhooks controller (Stage 4A + Stage 11).
//
// No auth middleware — callers are Stripe / Moralis; verification is signature-based.
// Raw body must be read via c.req.text() BEFORE any JSON parsing.

import { Hono } from 'hono';
import { err } from '../../lib/envelope.js';
import { processWebhookEvent } from './webhooks.service.js';
import { handleMoralisWebhook } from './moralis-handlers.js';

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

webhooksRouter.post('/moralis', async (c) => handleMoralisWebhook(c));
