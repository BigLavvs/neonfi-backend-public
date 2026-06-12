// Neonfi backend — Webhooks service: signature verification, idempotency, dispatch (Stage 4A).

import type Stripe from 'stripe';
import { stripe } from '../../lib/stripe.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { ok, err } from '../../lib/envelope.js';
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleChargeRefunded,
} from './stripe-handlers.js';

const REDIS_TTL_30_DAYS = 2592000;

const HANDLED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
]);

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event);
      break;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event);
      break;
  }
}

type WebhookResult = {
  status: number;
  body: ReturnType<typeof ok> | ReturnType<typeof err>;
};

export async function processWebhookEvent(
  rawBody: string,
  signature: string,
): Promise<WebhookResult> {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch {
    return { status: 401, body: err('INVALID_SIGNATURE', 'Webhook signature verification failed') };
  }

  const seen = await redis.get(`stripe_event:${event.id}`);
  if (seen) {
    return { status: 200, body: ok({ received: true, duplicate: true }) };
  }

  const isHandled = HANDLED_EVENT_TYPES.has(event.type);

  if (isHandled) {
    try {
      await dispatch(event);
    } catch (e) {
      console.error(
        '[webhooks]',
        JSON.stringify({ event: 'handler_error', eventId: event.id, eventType: event.type }),
        e,
      );
      return { status: 500, body: err('WEBHOOK_HANDLER_ERROR', 'Internal webhook handler error') };
    }
  } else {
    console.log(
      '[webhooks]',
      JSON.stringify({ event: 'event_unhandled', type: event.type, eventId: event.id }),
    );
  }

  await redis.set(`stripe_event:${event.id}`, '1', 'EX', REDIS_TTL_30_DAYS);

  if (!isHandled) {
    return { status: 200, body: ok({ received: true, unhandled: true }) };
  }
  return { status: 200, body: ok({ received: true }) };
}
