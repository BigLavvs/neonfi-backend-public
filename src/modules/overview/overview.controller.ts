// Neonfi backend — Overview module controller (retrofit-13).
//
// GET /api/v1/overview — the dashboard's cross-portfolio aggregate. Mounted top-level
// at /api/v1/overview (NOT under /portfolios) to avoid any collision with
// GET /portfolios/:id.
//
// Middleware: requireAuth ONLY. This endpoint is **plan-agnostic** — a free user with
// an active free subscription gets 200. The dashboard Overview (value chart, allocation,
// recent txs) is shown to free users; only the per-portfolio PnL breakdown and the
// Performance page stay Pro-gated on the analytics endpoints.

import { Hono } from 'hono';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { getOverview } from './overview.service.js';
import { listRecentUserTransactions } from '../transactions/transactions.service.js';

const router = new Hono<AuthEnv>();

router.use('*', requireAuth);

// Both query params are optional with safe defaults; out-of-range or non-numeric values
// are clamped into range (or fall back to the default), never a 400 — the dashboard
// should always render.
const clampTo =
  (lo: number, hi: number) =>
  (n: number): number =>
    Math.min(hi, Math.max(lo, n));

const OverviewQuerySchema = z.object({
  days: z.coerce.number().int().catch(90).transform(clampTo(1, 365)),
  txLimit: z.coerce.number().int().catch(10).transform(clampTo(1, 50)),
});

// ---------------------------------------------------------------------------
// GET /api/v1/overview
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const user = c.get('user');
  const { days, txLimit } = OverviewQuerySchema.parse({
    days: c.req.query('days'),
    txLimit: c.req.query('txLimit'),
  });
  // retrofit-50: optional comma-separated positive ints scoping the aggregate to a subset of
  // the user's portfolios. Empty/absent/all-garbage → undefined (= all). Ownership is enforced
  // in the service's where-clause, so unknown/foreign ids are silently dropped, never a 400.
  const ids = (c.req.query('portfolioIds') ?? '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const data = await getOverview(user.id, {
    days,
    txLimit,
    portfolioIds: ids.length ? ids : undefined,
  });
  return c.json(ok(data), 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/overview/transactions?limit= (retrofit-46)
// ---------------------------------------------------------------------------
// Every transaction the user owns, across ALL portfolios, newest-first. The frontend
// uses this to (a) build the holdings step function (holdings(t) = current − txns after t)
// and (b) drop buy/sell markers on the value chart, reconstructing value(t)=holdings(t)×
// price(t) client-side (the retrofit-45 backend reconstruction having been reverted).
// Same clamp-never-400 stance as GET /overview: limit defaults to 500, clamps to [1, 2000].
const TxQuerySchema = z.object({
  limit: z.coerce.number().int().catch(500).transform(clampTo(1, 2000)),
});

router.get('/transactions', async (c) => {
  const user = c.get('user');
  const { limit } = TxQuerySchema.parse({ limit: c.req.query('limit') });
  const transactions = await listRecentUserTransactions(user.id, limit);
  return c.json(ok({ transactions }), 200);
});

export { router as overviewRouter };
