// Neonfi backend — Hono application factory (Stage 1A).
//
// Separated from src/index.ts so tests can import the app without starting
// the HTTP server. src/index.ts is the only file that calls serve().
//
// Route tree:
//   GET  /health          — DB + Redis liveness (Coolify probe)
//   GET  /api/v1/_ping    — sanity check, delete in Stage 2
//   POST /api/v1/auth/*   — Stage 1A email auth flows

import { Hono } from 'hono';
import { config } from './lib/config.js';
import { checkHealth } from './lib/health.js';
import { err, ok } from './lib/envelope.js';
import { rateLimit } from './lib/rate-limit.js';
import { authRouter } from './modules/auth/auth.controller.js';
import { usersRouter } from './modules/users/users.controller.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.controller.js';
import { webhooksRouter } from './modules/webhooks/webhooks.controller.js';
import { paymentsRouter } from './modules/payments/payments.controller.js';
import { chainsRouter } from './modules/chains/chains.controller.js';
import { tokensRouter } from './modules/tokens/tokens.controller.js';
import { portfoliosRouter } from './modules/portfolios/portfolios.controller.js';
import { assetsRouter } from './modules/assets/assets.controller.js';
import { transactionsRouter } from './modules/transactions/transactions.controller.js';
import { pricesRouter } from './modules/prices/prices.controller.js';
import { nftsRouter } from './modules/nfts/nfts.controller.js';
import { snapshotsRouter } from './modules/snapshots/snapshots.controller.js';
import { analyticsRouter } from './modules/analytics/analytics.controller.js';
import { overviewRouter } from './modules/overview/overview.controller.js';
import { wsHealthHandler } from './ws/health.js';

export function createApp(): Hono {
  const app = new Hono();

  // Health check (not under /api/v1 — Coolify polls it directly)
  app.get('/health', async (c) => {
    const health = await checkHealth();
    if (health.ok) {
      return c.json(ok({ status: 'ok', db: health.db, redis: health.redis, coinbase: health.coinbase }), 200);
    }
    return c.json(err('HEALTH_FAILED', health.failure ?? 'dependency unavailable'), 503);
  });

  // API v1
  const api = new Hono();

  // Global IP rate limiting (audit SEC #27). Registered before the routes so it runs first.
  // No-ops when NODE_ENV=test or RATE_LIMIT_ENABLED=false. Webhooks are excluded (signature-
  // verified + idempotent; they arrive from provider IPs in bursts).
  api.use('*', rateLimit({
    id: 'global',
    limit: config.RATE_LIMIT_GLOBAL_MAX,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    skip: (c) => c.req.path.startsWith('/api/v1/webhooks'),
  }));
  // Tighter bucket on auth flows (brute force / credential stuffing / enumeration).
  api.use('/auth/*', rateLimit({
    id: 'auth',
    limit: config.RATE_LIMIT_AUTH_MAX,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
  }));
  // Tightest bucket on expensive provider-fanout + the refund endpoint.
  api.use('/portfolios/wallet/preview', rateLimit({
    id: 'wallet-preview',
    limit: config.RATE_LIMIT_SENSITIVE_MAX,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
  }));
  api.use('/subscriptions/refund', rateLimit({
    id: 'refund',
    limit: config.RATE_LIMIT_SENSITIVE_MAX,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
  }));

  api.get('/_ping', (c) => c.json(ok({ ok: true }), 200));
  api.route('/auth', authRouter);
  api.route('/users', usersRouter);
  api.route('/subscriptions', subscriptionsRouter);
  api.route('/webhooks', webhooksRouter);
  api.route('/payments', paymentsRouter);
  api.route('/chains', chainsRouter);
  api.route('/tokens', tokensRouter);
  api.route('/portfolios', portfoliosRouter);
  api.route('/portfolios/:portfolioId/assets', assetsRouter);
  api.route('/portfolios/:portfolioId/transactions', transactionsRouter);
  api.route('/portfolios/:portfolioId/nfts', nftsRouter);
  api.route('/portfolios/:portfolioId/snapshots', snapshotsRouter);
  api.route('/prices', pricesRouter);
  api.route('/analytics', analyticsRouter);
  api.route('/overview', overviewRouter);
  app.route('/api/v1', api);

  // WebSocket health — not under /api/v1 (Coolify polls externally, like /health)
  app.get('/ws/health', wsHealthHandler);

  // 404 + global error handler — standard envelopes, no stack traces
  app.notFound((c) => c.json(err('NOT_FOUND', 'Resource not found'), 404));
  app.onError((e, c) => {
    console.error('[error]', e);
    // Never leak internal error text by default. Verbose messages only with an explicit
    // DEBUG_ERRORS=true opt-in — NOT keyed on NODE_ENV (audit SEC error lockdown).
    const message = config.DEBUG_ERRORS ? e.message : 'Internal server error';
    return c.json(err('INTERNAL_ERROR', message), 500);
  });

  return app;
}

export const app = createApp();
