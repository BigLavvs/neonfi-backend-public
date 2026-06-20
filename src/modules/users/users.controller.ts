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
import { randomUUID } from 'node:crypto';
import { ok, err } from '../../lib/envelope.js';
import { clearAuthCookies } from '../../lib/cookies.js';
import { config, isAvatarStorageConfigured } from '../../lib/config.js';
import { putObject, deleteObject, publicUrl, keyFromPublicUrl } from '../../lib/storage.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { getMe, updateMe, updatePreferences, deleteMe } from './users.service.js';
import { updateProfile, toUserDTO } from './users.repository.js';
import { sniffImage } from './avatar.js';
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
// POST /users/me/avatar — upload a profile picture to R2 (retrofit-90)
//
// multipart/form-data, field `file`. Stores the image in the R2 `neonfi` bucket
// under avatars/<userId>/<uuid>.<ext> and persists its public URL in avatarUrl.
// Sniffs magic bytes (never trusts the multipart Content-Type). Best-effort
// deletes the previously stored avatar object. Storage failures → 502, never 500.
// ---------------------------------------------------------------------------

router.post('/me/avatar', requireAuth, async (c) => {
  if (!isAvatarStorageConfigured) {
    return c.json(err('AVATAR_STORAGE_UNAVAILABLE', 'Avatar uploads are not configured'), 503);
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  // Reject anything that isn't a File/Blob (string field, missing, etc.).
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return c.json(err('VALIDATION_ERROR', 'No file provided'), 400);
  }
  const blob = file as Blob;

  if (blob.size > config.AVATAR_MAX_BYTES) {
    return c.json(err('FILE_TOO_LARGE', 'Image exceeds 5 MB'), 400);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sniff = sniffImage(bytes);
  if (!sniff) {
    return c.json(err('UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, WEBP, GIF images are allowed'), 400);
  }

  const user = c.get('user');
  const key = `avatars/${user.id}/${randomUUID()}.${sniff.ext}`;
  try {
    await putObject(key, bytes, sniff.type);
    // Best-effort cleanup of the previous object — never block the upload on it.
    const oldKey = keyFromPublicUrl(user.avatarUrl);
    if (oldKey) await deleteObject(oldKey).catch(() => {});
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[avatar] upload failed', (e as Error).message);
    return c.json(err('AVATAR_UPLOAD_FAILED', 'Failed to store the avatar image'), 502);
  }

  const updated = await updateProfile(user.id, { avatarUrl: publicUrl(key) });
  return c.json(ok({ user: await toUserDTO(updated) }), 200);
});

// ---------------------------------------------------------------------------
// DELETE /users/me/avatar — clear the profile picture (retrofit-90)
//
// Removes the stored R2 object (best-effort) and nulls avatarUrl. Works even when
// R2 is unconfigured: keyFromPublicUrl returns null without R2_PUBLIC_BASE_URL, so
// the field is still cleared.
// ---------------------------------------------------------------------------

router.delete('/me/avatar', requireAuth, async (c) => {
  const user = c.get('user');
  const oldKey = keyFromPublicUrl(user.avatarUrl);
  if (oldKey) await deleteObject(oldKey).catch(() => {});
  const updated = await updateProfile(user.id, { avatarUrl: null });
  return c.json(ok({ user: await toUserDTO(updated) }), 200);
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
