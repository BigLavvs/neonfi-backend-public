import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  AssetError,
  addAsset,
  listAssets,
  getAsset,
  updateAsset,
  removeAsset,
} from './assets.service.js';
import { CreateAssetBodySchema, UpdateAssetBodySchema } from './assets.schemas.js';

type AssetEnv = AuthEnv & { Variables: { portfolio: PortfolioWithRelations } };

const router = new Hono<AssetEnv>();

function assetErr(e: AssetError) {
  if (e.meta) {
    return { error: { code: e.code, message: e.message }, meta: e.meta };
  }
  return err(e.code, e.message);
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Auth + portfolio-ownership middleware — applies to all asset routes
router.use('*', requireAuth);
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
// POST /portfolios/:portfolioId/assets
// ---------------------------------------------------------------------------

router.post('', async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = CreateAssetBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const user = c.get('user');
  const portfolio = c.get('portfolio');
  try {
    const asset = await addAsset(user.id, portfolio, parsed.data);
    return c.json(ok({ asset }), 201);
  } catch (e) {
    if (e instanceof AssetError) {
      return c.json(assetErr(e), e.statusCode as 400 | 403 | 409);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /portfolios/:portfolioId/assets
// ---------------------------------------------------------------------------

router.get('', async (c) => {
  const portfolio = c.get('portfolio');
  const slug = c.req.query('slug');
  const assets = await listAssets(portfolio, slug);
  return c.json(ok({ assets }), 200);
});

// ---------------------------------------------------------------------------
// GET /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Asset ID must be a positive integer'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const asset = await getAsset(portfolio, id);
    return c.json(ok({ asset }), 200);
  } catch (e) {
    if (e instanceof AssetError) {
      return c.json(assetErr(e), e.statusCode as 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PATCH /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

router.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Asset ID must be a positive integer'), 400);
  }
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = UpdateAssetBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const asset = await updateAsset(portfolio, id, parsed.data);
    return c.json(ok({ asset }), 200);
  } catch (e) {
    if (e instanceof AssetError) {
      return c.json(assetErr(e), e.statusCode as 400 | 403 | 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// DELETE /portfolios/:portfolioId/assets/:id
// ---------------------------------------------------------------------------

router.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Asset ID must be a positive integer'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    await removeAsset(portfolio, id);
    return c.json(ok({ ok: true }), 200);
  } catch (e) {
    if (e instanceof AssetError) {
      return c.json(assetErr(e), e.statusCode as 403 | 404);
    }
    throw e;
  }
});

export { router as assetsRouter };
