# retrofit-90 — decisions + shipped surface

Profile-avatar upload. The settings page could pick a picture but never save it: `User.avatarUrl`
is a URL column (`VarChar(2048)`) + `PatchMeSchema.avatarUrl` is `z.string().url().max(2048)`, and
there was no object storage anywhere in the backend. This retrofit is the backend half — an R2
client + authenticated upload/clear endpoints. (Frontend wiring is tracked on the frontend repo.)

## Decision — avatars = public R2 (public-URL model)

Store the uploaded image in the existing Cloudflare R2 `neonfi` bucket (S3-compatible) under the
`avatars/<userId>/<uuid>.<ext>` key prefix, served public-read from `R2_PUBLIC_BASE_URL`
(`https://images.neonfi.live`), and persist that **public URL** in `User.avatarUrl`. This matches
the column's existing semantics (a real URL) so **no migration** is needed, and avatars are
non-sensitive `<img>` content so a public-read bucket + stable URL is the right model — **no
per-request presigning**. If a private bucket is ever required, switch to presigned GET URLs
regenerated in `toUserDTO` (out of scope).

## What shipped

- **Dependency:** `@aws-sdk/client-s3` (R2 is S3-compatible; no presigner needed).
- **`src/lib/config.ts`:** new R2 group — `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
  `R2_BUCKET`/`R2_PUBLIC_BASE_URL` all **optional**, plus `AVATAR_MAX_BYTES` (default 5 MB). New
  derived export `isAvatarStorageConfigured` (true only when all five are set). All six documented
  in `.env.example`. Optional-everywhere + the guard means the app still **boots** where R2 isn't
  set; the endpoint 503s cleanly. (The five connection vars were already present in `.env` with
  working values but absent from the Zod schema — this is what makes them readable via `config`.)
- **`src/lib/storage.ts`** (new): lazy `S3Client` (`region:'auto'`, `forcePathStyle:true`),
  exposing only `putObject` + `deleteObject` + `publicUrl` + `keyFromPublicUrl`. Client built in
  `src/lib/` so `check:singletons` stays green.
- **`src/modules/users/avatar.ts`** (new): `sniffImage` — magic-byte sniff (PNG/JPEG/WEBP/GIF),
  never trusts the multipart Content-Type.
- **`src/modules/users/users.controller.ts`:** two `requireAuth` routes under `/api/v1/users`:
  - `POST /me/avatar` (multipart, field `file`): 503 if unconfigured → parse → 400 if not a
    File/Blob → size guard (400 `FILE_TOO_LARGE`) → read bytes → sniff (400
    `UNSUPPORTED_MEDIA_TYPE`) → `putObject(avatars/<id>/<uuid>.<ext>)` → best-effort delete the
    previous object → `updateProfile({ avatarUrl: publicUrl(key) })` → return the user DTO. Storage
    failures are caught → **502 `AVATAR_UPLOAD_FAILED`** (logged), never a 500.
  - `DELETE /me/avatar`: best-effort delete the stored object + `updateProfile({ avatarUrl: null })`.
    No 503 guard — `keyFromPublicUrl` returns null without `R2_PUBLIC_BASE_URL`, so clearing works
    even when R2 is unconfigured.
- Controller calls the repository (`updateProfile`/`toUserDTO`) directly — the work is storage-bound
  and HTTP-bound (multipart parse), so no new service functions were added; matches the module's
  thinness. `PatchMeSchema.avatarUrl` is left as-is (PATCH `{avatarUrl:null}` still clears the field;
  `DELETE /me/avatar` is preferred because it also removes the stored object).

## Out of scope
- No migration (column already fits public R2 URLs). No server-side image resizing (frontend
  downsizes; the 5 MB cap is a backstop — add `sharp` later if needed).

## Validate (all green)
- `npm run typecheck` clean; `check:singletons` OK.
- `tests/users.test.ts` 34/34 (added 60–68 with `../src/lib/storage.js` mocked so tests never touch
  R2; `isAvatarStorageConfigured` toggled via a partial `config.js` mock for the 503 case):
  happy-path PNG → 200 + `avatars/<id>/…png` key + persisted URL; non-image bytes → 400
  `UNSUPPORTED_MEDIA_TYPE` (proves sniff over Content-Type); oversize → 400 `FILE_TOO_LARGE`;
  no-auth → 401; replace → old key deleted; DELETE → null + deleted; unconfigured → 503; missing
  file field → 400.
- Manual (once R2 env set): upload a PNG via settings → 200 → avatar persists across reload + shows
  in the top-right chip.
