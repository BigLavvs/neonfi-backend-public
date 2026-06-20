import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePlan } from '../auth/plan.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { NftError, listNfts, getNftById } from './nfts.service.js';

type NftEnv = AuthEnv & { Variables: { portfolio: PortfolioWithRelations } };

const router = new Hono<NftEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Auth + plan gate + portfolio-ownership middleware — all NFT routes are Pro-only
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
// GET /portfolios/:portfolioId/nfts
// ---------------------------------------------------------------------------

router.get('', async (c) => {
  const portfolio = c.get('portfolio');
  // retrofit-84 (H13): `?includeSpam=true` (the "Show spam" toggle) reveals the hidden spam NFTs;
  // default hides them. spamCount always reports how many are hidden so the toggle can label itself.
  const includeSpam = c.req.query('includeSpam') === 'true';
  const { nfts, spamCount } = await listNfts(portfolio, { includeSpam });
  return c.json(ok({ nfts, spamCount }), 200);
});

// ---------------------------------------------------------------------------
// GET /portfolios/:portfolioId/nfts/:id
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'NFT ID must be a positive integer'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const nft = await getNftById(portfolio, id);
    return c.json(ok({ nft }), 200);
  } catch (e) {
    if (e instanceof NftError) {
      return c.json(err(e.code, e.message), e.statusCode as 404);
    }
    throw e;
  }
});

export { router as nftsRouter };
