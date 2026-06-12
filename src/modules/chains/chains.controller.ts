import { Hono } from 'hono';
import { ok } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { getVisibleChains } from './chains.service.js';

const router = new Hono<AuthEnv>();

router.get('', requireAuth, async (c) => {
  const user = c.get('user');
  const chains = await getVisibleChains(user.id);
  return c.json(ok({ chains }), 200);
});

export { router as chainsRouter };
