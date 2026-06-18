// Neonfi backend — Portfolios module controller (Stage 7).
//
// POST /portfolios discriminated union: type='connected' | type='manual'. Both use
// .strict() so unknown fields (including 'assets' from the legacy frontend
// NewPortfolioModal.svelte:339) are rejected with 400. Asset creation belongs to
// Stage 8 (POST /portfolios/{id}/assets).

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import { prisma } from '../../lib/prisma.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import {
  PortfolioError,
  createPortfolio,
  listPortfolios,
  getPortfolio,
  updatePortfolio,
  deletePortfolioById,
} from './portfolios.service.js';
import {
  CreatePortfolioBodySchema,
  ListPortfoliosQuerySchema,
  UpdatePortfolioBodySchema,
  walletPreviewSchema,
} from './portfolios.schemas.js';
import { previewWallet } from '../wallet-data/index.js';

const router = new Hono<AuthEnv>();

function portfolioErr(e: PortfolioError, status: number) {
  if (e.meta) {
    return { error: { code: e.code, message: e.message }, meta: e.meta };
  }
  return err(e.code, e.message);
}

function parsePortfolioId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// POST /portfolios
// ---------------------------------------------------------------------------

router.post('', requireAuth, async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = CreatePortfolioBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const user = c.get('user');
  try {
    const portfolio = await createPortfolio(user.id, parsed.data);
    return c.json(ok({ portfolio }), 201);
  } catch (e) {
    if (e instanceof PortfolioError) {
      return c.json(portfolioErr(e, e.statusCode), e.statusCode as 400 | 403 | 409);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /portfolios/wallet/preview  (retrofit-47)
//
// Looks the wallet up across the read-side providers and returns one of three outcomes
// the frontend branches on: found (+summary), empty (add-anyway), invalid. Registered
// BEFORE the /:id routes so the static path isn't shadowed by the dynamic param route.
// ---------------------------------------------------------------------------

router.post('/wallet/preview', requireAuth, async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = walletPreviewSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const chain = await prisma.chain.findUnique({ where: { id: parsed.data.chainId } });
  if (!chain) {
    return c.json(err('INVALID_CHAIN', 'Chain not found'), 400);
  }
  const preview = await previewWallet(parsed.data.walletAddress, chain);
  return c.json(ok(preview), 200);
});

// ---------------------------------------------------------------------------
// GET /portfolios
// ---------------------------------------------------------------------------

router.get('', requireAuth, async (c) => {
  const rawQuery = c.req.query();
  const parsed = ListPortfoliosQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const user = c.get('user');
  const result = await listPortfolios(user.id, parsed.data);
  return c.json(ok({ portfolios: result.portfolios }, result.meta), 200);
});

// ---------------------------------------------------------------------------
// GET /portfolios/:id
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (c) => {
  const id = parsePortfolioId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Portfolio ID must be a positive integer'), 400);
  }
  const user = c.get('user');
  try {
    const portfolio = await getPortfolio(user.id, id);
    return c.json(ok({ portfolio }), 200);
  } catch (e) {
    if (e instanceof PortfolioError) {
      return c.json(portfolioErr(e, e.statusCode), e.statusCode as 403);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PATCH /portfolios/:id
// ---------------------------------------------------------------------------

router.patch('/:id', requireAuth, async (c) => {
  const id = parsePortfolioId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Portfolio ID must be a positive integer'), 400);
  }
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = UpdatePortfolioBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const user = c.get('user');
  try {
    const portfolio = await updatePortfolio(user.id, id, parsed.data);
    return c.json(ok({ portfolio }), 200);
  } catch (e) {
    if (e instanceof PortfolioError) {
      return c.json(portfolioErr(e, e.statusCode), e.statusCode as 400 | 403 | 409);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// DELETE /portfolios/:id
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, async (c) => {
  const id = parsePortfolioId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Portfolio ID must be a positive integer'), 400);
  }
  const user = c.get('user');
  try {
    await deletePortfolioById(user.id, id);
    return c.json(ok({ ok: true }), 200);
  } catch (e) {
    if (e instanceof PortfolioError) {
      return c.json(portfolioErr(e, e.statusCode), e.statusCode as 403);
    }
    throw e;
  }
});

export { router as portfoliosRouter };
