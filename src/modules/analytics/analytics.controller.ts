// Neonfi backend — Analytics module controller (Stage 14 §1.2).
//
// Three Pro-only, ownership-gated read endpoints, mounted top-level at
// /api/v1/analytics (NOT nested under /portfolios — confirmed vs frontend
// endpoints.ts:21):
//   GET /api/v1/analytics/:portfolioId/summary
//   GET /api/v1/analytics/:portfolioId/performance
//   GET /api/v1/analytics/:portfolioId/holdings
//
// Middleware chain mirrors snapshots.controller.ts verbatim: requireAuth →
// requirePlan(['pro']) → portfolio-ownership. A free user with an active free
// subscription gets 403 PLAN_LIMIT_REACHED; another user's portfolio gets 403
// FORBIDDEN. The frontend handles 403 client-side via the ProGate overlay.

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePlan } from '../auth/plan.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { getSummary, getPerformance, getHoldings } from './analytics.service.js';

type AnalyticsEnv = AuthEnv & { Variables: { portfolio: PortfolioWithRelations } };

const router = new Hono<AnalyticsEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Auth + Pro gate + portfolio-ownership middleware — analytics is Pro-only.
// Mirrors snapshots.controller.ts:27-41. Difference from snapshots: there the
// :portfolioId param lives in the mount prefix (/portfolios/:portfolioId/snapshots),
// so a wildcard middleware sees it; here it's mounted top-level at /analytics and the
// param lives in the leaf route. Hono resolves c.req.param() per matched route, so
// the ownership middleware is registered on '/:portfolioId/*' (not '*') to capture it.
router.use('*', requireAuth);
router.use('*', requirePlan(['pro']));
router.use('/:portfolioId/*', async (c, next) => {
  const user = c.get('user');
  const portfolioId = parseId(c.req.param('portfolioId') ?? '');
  if (portfolioId === null) {
    return c.json(err('VALIDATION_ERROR', 'Invalid portfolio ID'), 400);
  }
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio || portfolio.userId !== user.id) {
    return c.json(err('FORBIDDEN', 'Portfolio not found or access denied'), 403);
  }
  c.set('portfolio', portfolio);
  await next();
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/:portfolioId/summary
// ---------------------------------------------------------------------------

router.get('/:portfolioId/summary', async (c) => {
  const portfolio = c.get('portfolio');
  const data = await getSummary(portfolio.id);
  return c.json(ok(data), 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/:portfolioId/performance
// ---------------------------------------------------------------------------

router.get('/:portfolioId/performance', async (c) => {
  const portfolio = c.get('portfolio');
  const data = await getPerformance(portfolio.id);
  return c.json(ok(data), 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/:portfolioId/holdings
// ---------------------------------------------------------------------------

router.get('/:portfolioId/holdings', async (c) => {
  const portfolio = c.get('portfolio');
  const data = await getHoldings(portfolio);
  return c.json(ok(data), 200);
});

export { router as analyticsRouter };
