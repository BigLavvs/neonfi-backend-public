import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  TransactionError,
  createTransaction,
  createCrossPortfolioTransfer,
  listPortfolioTransactions,
  getPortfolioTransaction,
  updateTransaction,
  deleteTransaction,
} from './transactions.service.js';
import {
  CreateTransactionBodySchema,
  UpdateTransactionBodySchema,
  TransferBodySchema,
} from './transactions.schemas.js';

type TxEnv = AuthEnv & { Variables: { portfolio: PortfolioWithRelations } };

const router = new Hono<TxEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Auth + portfolio-ownership middleware — applies to all transaction routes
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
// POST /portfolios/:portfolioId/transactions
// ---------------------------------------------------------------------------

router.post('', async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = CreateTransactionBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const transaction = await createTransaction(portfolio, parsed.data);
    return c.json(ok({ transaction }), 201);
  } catch (e) {
    if (e instanceof TransactionError) {
      return c.json(err(e.code, e.message), e.statusCode as 400 | 403 | 409);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /portfolios/:portfolioId/transactions/transfer (retrofit-10 / C4b)
// ---------------------------------------------------------------------------
// Cross-portfolio transfer: the URL :portfolioId is the SOURCE; the body names the
// dest. Distinct literal path — no conflict with POST '' or the '/:id' routes.

router.post('/transfer', async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = TransferBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const portfolio = c.get('portfolio'); // SOURCE
  try {
    const transfer = await createCrossPortfolioTransfer(portfolio, parsed.data);
    return c.json(ok({ transfer }), 201);
  } catch (e) {
    if (e instanceof TransactionError) {
      return c.json(err(e.code, e.message), e.statusCode as 400 | 403);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /portfolios/:portfolioId/transactions
// ---------------------------------------------------------------------------

router.get('', async (c) => {
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const type = c.req.query('type');
  const sort = c.req.query('sort');
  const order = c.req.query('order');

  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 20;
  const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return c.json(err('VALIDATION_ERROR', 'limit must be between 1 and 100'), 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return c.json(err('VALIDATION_ERROR', 'offset must be >= 0'), 400);
  }
  if (type !== undefined && !['native', 'erc20', 'nft'].includes(type)) {
    return c.json(err('VALIDATION_ERROR', 'type must be native, erc20, or nft'), 400);
  }
  if (sort !== undefined && !['timestamp', 'createdAt'].includes(sort)) {
    return c.json(err('VALIDATION_ERROR', 'sort must be timestamp or createdAt'), 400);
  }
  if (order !== undefined && !['asc', 'desc'].includes(order)) {
    return c.json(err('VALIDATION_ERROR', 'order must be asc or desc'), 400);
  }

  const portfolio = c.get('portfolio');
  const result = await listPortfolioTransactions(portfolio, {
    limit,
    offset,
    type: type as string | undefined,
    sort: (sort ?? 'timestamp') as 'timestamp' | 'createdAt',
    order: (order ?? 'desc') as 'asc' | 'desc',
  });

  return c.json(ok({ transactions: result.transactions }, result.meta), 200);
});

// ---------------------------------------------------------------------------
// GET /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Transaction ID must be a positive integer'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const transaction = await getPortfolioTransaction(portfolio, id);
    return c.json(ok({ transaction }), 200);
  } catch (e) {
    if (e instanceof TransactionError) {
      return c.json(err(e.code, e.message), e.statusCode as 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PATCH /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

router.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Transaction ID must be a positive integer'), 400);
  }
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody === null) {
    return c.json(err('VALIDATION_ERROR', 'Request body required'), 400);
  }
  const parsed = UpdateTransactionBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    const transaction = await updateTransaction(portfolio, id, parsed.data);
    return c.json(ok({ transaction }), 200);
  } catch (e) {
    if (e instanceof TransactionError) {
      return c.json(err(e.code, e.message), e.statusCode as 400 | 403 | 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// DELETE /portfolios/:portfolioId/transactions/:id
// ---------------------------------------------------------------------------

router.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) {
    return c.json(err('VALIDATION_ERROR', 'Transaction ID must be a positive integer'), 400);
  }
  const portfolio = c.get('portfolio');
  try {
    await deleteTransaction(portfolio, id);
    return c.json(ok({ ok: true }), 200);
  } catch (e) {
    if (e instanceof TransactionError) {
      return c.json(err(e.code, e.message), e.statusCode as 403 | 404);
    }
    throw e;
  }
});

export { router as transactionsRouter };
