# retrofit-23: green the full local test suite (vitest singleFork + session-JWT jti)

Tests now run on a **local Postgres** (`DATABASE_URL_TEST`). Per-file gate runs are green, but a
full `npm test` flakes under load. Two distinct causes, two targeted fixes. Neither touches
product behaviour beyond the JWT claim noted below.

Observed failures in the full run (all NON-deterministic except auth #11):
- ~18 tests fail with `session_userId_fkey violated` (during `login`) or
  `prisma.user.findUniqueOrThrow … No record found` (in test helpers) — i.e. a user row is gone
  mid-test. Classic **cross-file truncation race**: one file's data is truncated by another
  file's `beforeEach truncateAllUserData()` while it's still in use. Only happens when files
  overlap; per-file runs are clean.
- auth #11 (`refresh … issues a new session cookie`) fails because the session JWT's `iat` is
  **second-granular**, so on a fast DB login+refresh land in the same second → byte-identical
  token → `expect(new).not.toBe(old)` fails. Neon's latency hid this.

Read first: `vitest.config.ts`, and the auth token signer (where the `session` cookie's JWT is
created at login/refresh — likely `src/modules/auth/*jwt*` / `tokens` / `auth.service.ts`).

---

## Part 1 — vitest: run the whole suite in ONE process (kills the truncation race)
`fileParallelism: false` is set but files still overlap enough to race on the shared DB. Force a
single fork so every file runs strictly sequentially against the one Prisma client/connection.

In `vitest.config.ts` `test`:
```ts
pool: 'forks',
poolOptions: { forks: { singleFork: true } },
```
Keep the existing `fileParallelism: false`, `sequence: { sequential: true }`, and timeouts.

---

## Part 2 — session JWT `jti` (fixes auth #11; also a real improvement)
Add a unique `jti` claim to every signed **session/access** token so two issued in the same second
are always distinct. In the token signer, add `jti: randomUUID()` (Node `crypto.randomUUID()`) to
the payload. This is **additive** — do NOT change verification logic or any other claim; the
session is still validated by its existing `sessionId` + DB lookup. (Don't touch the refresh
token or WS ticket.)

---

## Gates (DATABASE_URL_TEST set, dev server stopped)
1. `npx vitest run` (FULL suite) → green except snapshots **#300 skipped** (retrofit-22). In
   particular auth #11 passes and the prior ~18 race failures are gone.
2. Run the full suite a SECOND time to confirm stability (0 flakes).
3. If any non-#300 test STILL fails after singleFork, report it verbatim — that would be a
   within-handler read-after-write issue (e.g. moralis #280), not the cross-file race, and needs
   separate handling rather than weakening the test.

## Commit (explicit add, no -A)
```bash
git add vitest.config.ts <auth-token-signer-file(s)> _claude/retrofit-23.md
git commit -m "test: single-fork vitest pool + session-JWT jti — green full local suite (retrofit-23)"
```
Report SHA + the full-suite passed/skipped/failed counts (both runs) + which file got the `jti`.
