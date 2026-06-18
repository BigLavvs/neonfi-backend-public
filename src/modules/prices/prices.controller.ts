// POST /api/v1/prices/refresh — free-user manual price refresh (Stage 10A).

import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { ok, err } from '../../lib/envelope.js';
import { requireAuth } from '../auth/middleware.js';
import type { AuthEnv } from '../auth/middleware.js';
import { refreshBodySchema, historyQuerySchema, type HistoryQuery } from './prices.schemas.js';
import { resolveSymbolsForUser, refreshPrices, getPriceDebug, getPriceHistory } from './prices.service.js';

const RATE_LIMIT_TTL_S = 30;

export const pricesRouter = new Hono<AuthEnv>();

pricesRouter.post('/refresh', requireAuth, async (c) => {
  // --- Parse body ---
  let body: { symbols?: string[] };
  try {
    body = refreshBodySchema.parse(await c.req.json().catch(() => ({})));
  } catch {
    return c.json(err('VALIDATION_ERROR', 'Invalid request body — max 5 symbols'), 400);
  }

  const user = c.get('user');

  // --- Plan check: free only (mid-onboarding = no subscription = allowed) ---
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    include: { plan: true, status: true },
  });

  if (subscription) {
    const now = new Date();
    const effectivelyActive =
      subscription.status.name === 'active' ||
      (subscription.status.name === 'cancelled' &&
        subscription.currentPeriodEnd !== null &&
        subscription.currentPeriodEnd > now);

    if (effectivelyActive && subscription.plan.name === 'pro') {
      return c.json(err('PRO_USES_WEBSOCKET', 'Pro users receive live prices via WebSocket'), 403);
    }
  }

  // --- Rate limit: one refresh per 30s per user ---
  const rateLimitKey = `refresh_rate:${user.id}`;
  const acquired = await redis.set(rateLimitKey, '1', 'EX', RATE_LIMIT_TTL_S, 'NX');
  if (!acquired) {
    const ttl = await redis.ttl(rateLimitKey);
    return c.json(
      { error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded — wait before refreshing again' }, meta: { retryAfterMs: ttl * 1000 } },
      429,
    );
  }

  // --- Resolve symbols ---
  let symbols: string[];
  try {
    symbols = await resolveSymbolsForUser(user.id, body.symbols);
  } catch (e) {
    const code = (e as { code?: string }).code === 'UNKNOWN_SYMBOL' ? 'UNKNOWN_SYMBOL' : 'VALIDATION_ERROR';
    return c.json(err(code, (e as Error).message), 400);
  }

  if (symbols.length === 0) {
    return c.json(ok({ prices: [] }), 200);
  }

  // --- Fetch from CMC + write cache ---
  const result = await refreshPrices(user.id, symbols);

  return c.json(ok({ prices: result.prices, ...(result.partialFailure ? { partialFailure: true } : {}) }), 200);
});

// GET /api/v1/prices/history?symbols=BTC,ETH&range=1H — one price-at-time series per symbol at
// any range. 1H/1D come from the resolver's Redis buffer (≤24h, 3-min samples); 1W/1M/1Y/ALL
// come from the daily TokenPriceSnapshot close series (retrofit-46). Auth-required, not Pro-gated
// (read-only catalog price data — same stance as GET /tokens/:id/history).
pricesRouter.get('/history', requireAuth, async (c) => {
  let q: HistoryQuery;
  try {
    q = historyQuerySchema.parse({
      symbols: c.req.query('symbols') ?? '',
      range: c.req.query('range') ?? '1H',
    });
  } catch {
    return c.json(err('VALIDATION_ERROR', 'symbols required; range must be one of 1H,1D,1W,1M,1Y,ALL'), 400);
  }
  if (q.symbols.length === 0) return c.json(ok({ history: {} }), 200);
  const history = await getPriceHistory(q.symbols, q.range);
  return c.json(ok({ history }), 200);
});

// GET /api/v1/prices/debug?symbol=BTC — read-only source-visibility readout (retrofit-35).
// Behind requireAuth (diagnostic, not public). With a symbol → that symbol's canonical price
// + every per-exchange source (ageMs/stale). Without one → the first N catalog symbols.
pricesRouter.get('/debug', requireAuth, async (c) => {
  const symbol = c.req.query('symbol');
  const data = await getPriceDebug(symbol);
  return c.json(ok(data), 200);
});
