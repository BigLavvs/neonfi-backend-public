import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import { SNAPSHOT_RETENTION_DAYS } from '../../lib/constants.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePlan } from '../auth/plan.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { listPortfolioSnapshots } from './snapshots.service.js';

type SnapshotEnv = AuthEnv & { Variables: { portfolio: PortfolioWithRelations } };

const router = new Hono<SnapshotEnv>();

// Default one year of dailies; cap at the retention window (no point requesting
// more than we keep). Mirrors the architecture/Build Guide §2.4 pagination rule.
const DEFAULT_LIMIT = 365;
const MAX_LIMIT = SNAPSHOT_RETENTION_DAYS; // 730

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Auth + Pro gate + portfolio-ownership middleware — snapshots are Pro-only.
// Mirrors nfts.controller.ts exactly.
router.use('*', requireAuth);
router.use('*', requirePlan(['pro']));
router.use('*', async (c, next) => {
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
// GET /portfolios/:portfolioId/snapshots
// ---------------------------------------------------------------------------

router.get('', async (c) => {
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');

  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;
  const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return c.json(err('VALIDATION_ERROR', `limit must be between 1 and ${MAX_LIMIT}`), 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return c.json(err('VALIDATION_ERROR', 'offset must be >= 0'), 400);
  }

  const portfolio = c.get('portfolio');
  const result = await listPortfolioSnapshots(portfolio, { limit, offset });
  return c.json(ok({ snapshots: result.snapshots }, result.meta), 200);
});

export { router as snapshotsRouter };
