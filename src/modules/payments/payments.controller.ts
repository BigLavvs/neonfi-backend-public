import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { PaymentError, listMyPayments, getPaymentById } from './payments.service.js';
import { ListPaymentsQuerySchema } from './payments.schemas.js';

const router = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// GET /payments — list own payments (paginated)
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (c) => {
  const rawQuery = c.req.query();
  const parsed = ListPaymentsQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  const user = c.get('user');
  const result = await listMyPayments(user.id, parsed.data);
  return c.json(ok({ payments: result.payments }, result.meta), 200);
});

// ---------------------------------------------------------------------------
// GET /payments/:id — read one payment
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (c) => {
  const rawId = c.req.param('id');
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json(err('VALIDATION_ERROR', 'Payment ID must be a positive integer'), 400);
  }

  const user = c.get('user');
  try {
    const result = await getPaymentById(user.id, id);
    return c.json(ok(result), 200);
  } catch (e) {
    if (e instanceof PaymentError) {
      return c.json(err(e.code, e.message), e.statusCode as 403);
    }
    throw e;
  }
});

export { router as paymentsRouter };
