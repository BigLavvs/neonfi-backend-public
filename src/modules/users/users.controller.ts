// Neonfi backend — Users module: route controller (Stage 2).
//
// Mounted at /api/v1/users by src/app.ts.
//
// Endpoints:
//   GET  /users/me — read own profile (requireAuth)
//   PATCH /users/me — update own profile (requireAuth)
//
// Out of scope (doc-fix items — need spec update before building):
//   POST DELETE /users/me/password — password change for email users
//   DELETE /users/me              — account deletion
//   PATCH /users/me with `email`  — email change requires re-verification flow

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { getMe, updateMe } from './users.service.js';
import { PatchMeSchema } from './users.schemas.js';

const router = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// GET /users/me — read own profile
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json(ok(getMe(user)), 200);
});

// ---------------------------------------------------------------------------
// PATCH /users/me — partial update (all fields optional)
// ---------------------------------------------------------------------------

router.patch('/me', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = PatchMeSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  const user = c.get('user');
  const result = await updateMe(user, parsed.data);
  return c.json(ok(result), 200);
});

export { router as usersRouter };
