// Neonfi backend — Users module: route controller (Stage 2).
//
// Mounted at /api/v1/users by src/app.ts.
//
// Endpoints:
//   GET    /users/me          — read own profile (requireAuth)
//   PATCH  /users/me          — update own profile (requireAuth)
//   DELETE /users/me          — delete own account (requireAuth)
//   PATCH  /users/preferences — update notification/display preferences (requireAuth)

import { Hono } from 'hono';
import { ok, err } from '../../lib/envelope.js';
import { clearAuthCookies } from '../../lib/cookies.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { getMe, updateMe, updatePreferences, deleteMe } from './users.service.js';
import { PatchMeSchema, PatchPreferencesSchema } from './users.schemas.js';

const router = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// GET /users/me — read own profile
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json(ok(await getMe(user)), 200);
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

// ---------------------------------------------------------------------------
// DELETE /users/me — hard-delete own account (Danger Zone)
// ---------------------------------------------------------------------------

router.delete('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const result = await deleteMe(user);
  // Mirror logout: clear the session/refresh cookies after deletion.
  clearAuthCookies(c);
  return c.json(ok(result), 200);
});

// ---------------------------------------------------------------------------
// PATCH /users/preferences — update notification/display preferences
// ---------------------------------------------------------------------------

router.patch('/preferences', requireAuth, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = PatchPreferencesSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(err('VALIDATION_ERROR', issue?.message ?? 'Validation failed'), 400);
  }

  const user = c.get('user');
  const result = await updatePreferences(user, parsed.data);
  return c.json(ok(result), 200);
});

export { router as usersRouter };
