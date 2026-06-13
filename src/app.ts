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
import { isProduction } from './lib/config.js';
import { checkHealth } from './lib/health.js';
import { err, ok } from './lib/envelope.js';
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
  api.route('/prices', pricesRouter);
  app.route('/api/v1', api);

  // WebSocket health — not under /api/v1 (Coolify polls externally, like /health)
  app.get('/ws/health', wsHealthHandler);

  // 404 + global error handler — standard envelopes, no stack traces
  app.notFound((c) => c.json(err('NOT_FOUND', 'Resource not found'), 404));
  app.onError((e, c) => {
    console.error('[error]', e);
    const message = isProduction ? 'Internal server error' : e.message;
    return c.json(err('INTERNAL_ERROR', message), 500);
  });

  return app;
}

export const app = createApp();
