import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { TokenError, listTokens, getTokenById, getTokenPriceHistory } from './tokens.service.js';
import { ListTokensQuerySchema, TokenHistoryQuerySchema } from './tokens.schemas.js';

const router = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// GET /tokens — cursor-paginated, searchable, plan-filtered list
// ---------------------------------------------------------------------------

router.get('', requireAuth, async (c) => {
  const rawQuery = c.req.query();
  const parsed = ListTokensQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  const user = c.get('user');
  const result = await listTokens(user.id, parsed.data);
  return c.json(ok({ tokens: result.tokens }, result.meta), 200);
});

// ---------------------------------------------------------------------------
// GET /tokens/:id/history — daily price history + ATH/ATL (no plan gate; matches
// GET /tokens/:id). Registered before /:id so the two-segment route is unambiguous.
// retrofit-21.
// ---------------------------------------------------------------------------

router.get('/:id/history', requireAuth, async (c) => {
  const rawId = c.req.param('id');
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json(err('VALIDATION_ERROR', 'Token ID must be a positive integer'), 400);
  }

  // `days` clamps internally (1–3650) and `.catch`es malformed input, so this parse
  // effectively never fails — the 400 branch is a defensive mirror of GET /tokens.
  const parsed = TokenHistoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  try {
    const history = await getTokenPriceHistory(id, parsed.data.days);
    return c.json(ok(history), 200);
  } catch (e) {
    if (e instanceof TokenError) {
      return c.json(err(e.code, e.message), e.statusCode as 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /tokens/:id — token detail (no plan gate)
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (c) => {
  const rawId = c.req.param('id');
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json(err('VALIDATION_ERROR', 'Token ID must be a positive integer'), 400);
  }

  try {
    const token = await getTokenById(id);
    return c.json(ok({ token }), 200);
  } catch (e) {
    if (e instanceof TokenError) {
      return c.json(err(e.code, e.message), e.statusCode as 404);
    }
    throw e;
  }
});

export { router as tokensRouter };
