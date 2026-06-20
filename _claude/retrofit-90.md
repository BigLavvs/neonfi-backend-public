# retrofit-90 — Profile avatar upload (Cloudflare R2 object storage)

**Status:** spec (for implementation)
**Owner:** backend
**Depends on:** none (additive). `User.avatarUrl` column already exists (`VarChar(2048)`),
is already in `UserDTO` (`users.repository.ts`) and already settable via `updateProfile`.

---

## Problem

The settings page lets a user pick a profile picture, but it can never be saved:

- `User.avatarUrl` is a **URL** column (`VarChar(2048)`) and `PatchMeSchema.avatarUrl` is
  validated as `z.string().url().max(2048)`.
- There is **no file-upload / object-storage** anywhere in the backend (the only S3-ish code is
  token-logo handling). So a picked file (a base64 data URL, far bigger than 2048 chars and not a
  normal URL) cannot be stored.
- Consequently the frontend `saveProfile()` deliberately omits `avatarUrl` and the UI shows
  "Preview only — avatar saving is coming soon." The top-right avatar (`TopBar.svelte`) only ever
  renders initials.

Decision (Idowu): use **object storage (Cloudflare R2, S3-compatible)** — store the uploaded image
in a bucket and persist its **public URL** in `User.avatarUrl`. This matches the existing column
semantics (a real URL) and the Ageless MVP storage pattern.

This retrofit is the **backend half**: an R2 client + an authenticated upload/clear endpoint. The
frontend half (upload the file, render the returned URL in settings + TopBar/Sidebar) is tracked
separately on the frontend repo.

---

## Provisioning — ALREADY DONE ✅ (just needs wiring)

R2 is **already provisioned** in `.env`: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET=neonfi`, `R2_PUBLIC_BASE_URL=https://images.neonfi.live` are all set with working values.

**IMPORTANT:** those vars are present in `.env` but are **NOT currently in `config.ts`'s Zod schema**,
so the loader doesn't expose them yet. §1 below adds them (optional) — that's what actually makes them
readable via `config`. No new bucket needed: reuse the existing `neonfi` bucket; avatar objects are
namespaced under the `avatars/...` key prefix, served from `images.neonfi.live`.

Keep the schema entries **optional** + the `isAvatarStorageConfigured` guard anyway, so the app still
boots (and the endpoint 503s cleanly) on any machine where the R2 vars aren't set.

Avatars are non-sensitive and embedded in an `<img>`, so a **public-read** bucket + stable public URL
is the right model (no per-request presigning). If a private bucket is ever required, switch to
presigned GET URLs regenerated in `toUserDTO` — out of scope here.

---

## Dependencies

Add `@aws-sdk/client-s3` (R2 is S3-compatible). No presigner needed for the public-URL model.

```
npm i @aws-sdk/client-s3
```

---

## 1. Env schema (`src/lib/config.ts`)

Add an R2 group. Keep each var **optional** (the app must still boot for everyone who hasn't set up
R2). Add a derived `isAvatarStorageConfigured` boolean.

```ts
// --- Avatar object storage (Cloudflare R2, retrofit-90) ---
// All optional: when any is missing, the avatar upload endpoint returns 503 AVATAR_STORAGE_UNAVAILABLE
// and the rest of the app is unaffected.
R2_ENDPOINT: z.string().url().optional(),
R2_ACCESS_KEY_ID: z.string().min(1).optional(),
R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
R2_BUCKET: z.string().min(1).optional(),
R2_PUBLIC_BASE_URL: z.string().url().optional(),
// Upload guardrails (sensible defaults; overridable).
AVATAR_MAX_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024), // 5 MB
```

After `export const config`:

```ts
export const isAvatarStorageConfigured =
  !!config.R2_ENDPOINT && !!config.R2_ACCESS_KEY_ID && !!config.R2_SECRET_ACCESS_KEY &&
  !!config.R2_BUCKET && !!config.R2_PUBLIC_BASE_URL;
```

Document all six in `.env.example`.

---

## 2. Storage helper (`src/lib/storage.ts`) — new

Mirror the Ageless `storage.ts` pattern (lazy S3 client, `region:'auto'`, `forcePathStyle:true`),
but expose only what avatars need: `putObject` + `deleteObject`. No presigning.

```ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config, isAvatarStorageConfigured } from './config.js';

let client: S3Client | null = null;
function r2(): S3Client {
  if (!isAvatarStorageConfigured) throw new Error('R2 not configured');
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT!,
      forcePathStyle: true,
      credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY! },
    });
  }
  return client;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await r2().send(new PutObjectCommand({ Bucket: config.R2_BUCKET!, Key: key, Body: body, ContentType: contentType }));
}
export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET!, Key: key }));
}

/** Public URL for a stored object key. */
export function publicUrl(key: string): string {
  return `${config.R2_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`;
}
/** If a stored avatarUrl is one of ours, recover its object key (else null). */
export function keyFromPublicUrl(url: string | null): string | null {
  if (!url || !config.R2_PUBLIC_BASE_URL) return null;
  const base = config.R2_PUBLIC_BASE_URL.replace(/\/$/, '') + '/';
  return url.startsWith(base) ? url.slice(base.length) : null;
}
```

---

## 3. Avatar validation (image sniff)

Do **not** trust the multipart `Content-Type` alone. Sniff magic bytes and map to an allowed type +
extension. Allowed: PNG, JPEG, WEBP, GIF. Put this in `src/modules/users/avatar.ts` (new) or inline.

```ts
const SIGS: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: 'image/png',  ext: 'png',  test: b => b[0]===0x89 && b[1]===0x50 && b[2]===0x4e && b[3]===0x47 },
  { type: 'image/jpeg', ext: 'jpg',  test: b => b[0]===0xff && b[1]===0xd8 && b[2]===0xff },
  { type: 'image/gif',  ext: 'gif',  test: b => b[0]===0x47 && b[1]===0x49 && b[2]===0x46 },
  { type: 'image/webp', ext: 'webp', test: b => b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50 },
];
export function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  return SIGS.find(s => s.test(bytes)) ?? null;
}
```

---

## 4. Endpoints (`src/modules/users/users.controller.ts`)

Both `requireAuth`. Mounted under the existing `/api/v1/users`. Apply the **same write rate-limit**
as other user mutations if the codebase has one.

### POST `/users/me/avatar` — upload

1. If `!isAvatarStorageConfigured` → `503 err('AVATAR_STORAGE_UNAVAILABLE', 'Avatar uploads are not configured')`.
2. Parse multipart: `const body = await c.req.parseBody()` → `const file = body['file']`.
   - Reject if not a `File`/`Blob` → `400 err('VALIDATION_ERROR', 'No file provided')`.
3. Size guard: `if (file.size > config.AVATAR_MAX_BYTES)` → `400 err('FILE_TOO_LARGE', 'Image exceeds 5 MB')`.
4. Read bytes: `const bytes = new Uint8Array(await file.arrayBuffer())`.
5. `const sniff = sniffImage(bytes)`; if null → `400 err('UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, WEBP, GIF images are allowed')`.
6. `const key = \`avatars/${user.id}/${crypto.randomUUID()}.${sniff.ext}\``.
7. `await putObject(key, bytes, sniff.type)`.
8. Best-effort delete the previous object: `const oldKey = keyFromPublicUrl(user.avatarUrl); if (oldKey) await deleteObject(oldKey).catch(()=>{})`.
9. `const updated = await updateProfile(user.id, { avatarUrl: publicUrl(key) })`.
10. Return `c.json(ok({ user: await toUserDTO(updated) }), 200)`.

Wrap storage calls so an R2 failure → `502 err('AVATAR_UPLOAD_FAILED', ...)` (logged), never a 500.

### DELETE `/users/me/avatar` — clear

1. `const oldKey = keyFromPublicUrl(user.avatarUrl); if (oldKey) await deleteObject(oldKey).catch(()=>{})`.
2. `const updated = await updateProfile(user.id, { avatarUrl: null })`.
3. Return `ok({ user: await toUserDTO(updated) })`.

> Keep `PatchMeSchema.avatarUrl` as-is — `PATCH /users/me { avatarUrl: null }` still works to clear
> the field, but `DELETE /users/me/avatar` is preferred because it also removes the stored object.
> (Do NOT allow PATCH to set an arbitrary external avatarUrl string to a non-R2 host if you want to
> keep avatars first-party; optional — current `.url()` validation already constrains it.)

Service layer: add `uploadAvatar(user, bytes, ...)` / `clearAvatar(user)` in `users.service.ts` if
you prefer the controller to stay thin (consistent with `updateMe`); the controller can also call
the repository directly given the logic is storage-bound. Match the module's existing thinness.

---

## 5. Tests (`tests/users.test.ts`)

Mock the storage module (`vi.mock('../src/lib/storage.js')`) so tests never touch R2. Force
`isAvatarStorageConfigured` true via mocked config or by setting the R2_* test envs to dummies.

- POST happy path: valid PNG bytes → 200, `data.user.avatarUrl` starts with `R2_PUBLIC_BASE_URL`,
  `putObject` called once with an `avatars/<id>/...png` key.
- Reject non-image bytes → 400 UNSUPPORTED_MEDIA_TYPE; `putObject` not called.
- Reject oversize (bytes > AVATAR_MAX_BYTES) → 400 FILE_TOO_LARGE.
- Reject unauthenticated → 401.
- Upload when a previous avatar exists → old key `deleteObject`d.
- DELETE clears avatarUrl → 200, `data.user.avatarUrl === null`, `deleteObject` called.
- Storage unconfigured → 503 AVATAR_STORAGE_UNAVAILABLE.

---

## 6. Out of scope / notes

- **No migration** — `avatarUrl` column already exists and public R2 URLs fit in 2048 chars.
- **No image resizing server-side** — the frontend downsizes before upload (small payloads); the
  5 MB cap is a backstop. (If you want server-side normalization later, add `sharp` — separate.)
- **Frontend** (separate repo): `POST /users/me/avatar` as `multipart/form-data` (field `file`),
  render the returned `data.user.avatarUrl`; `DELETE` to clear; TopBar/Sidebar render the image.
- Record a one-line decision in the backend decisions log (avatars = public R2, public-URL model).

## Verify

- `npm run typecheck` / build green.
- `npm test` (users suite) green with storage mocked.
- Manual (once R2 env set): upload a PNG via the settings page → 200 → avatar persists across reload
  and appears in the top-right chip.
