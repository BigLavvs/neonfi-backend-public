# Audit Remediation Plan — execution prompt for Claude Code (CC)

**Created:** 2026-06-21 · **Author of decisions:** Idowu
**Backlog:** `C:\Users\pelum\Desktop\neonfi-backend\AUDIT-COMPREHENSIVE-2026-06-21.md` (470 findings, each with `file:line` + a concrete fix)
**Repos (fix BOTH):**
- Backend — `C:\Users\pelum\Desktop\neonfi-backend` (Hono + Prisma + Redis + WS)
- Frontend — `C:\Users\pelum\Desktop\Neonfi` (SvelteKit 2 / Svelte 5)

---

## Mission

Work through **every** finding in the audit report (all severities: 1 Critical, 32 High, 99 Medium, 270 Low)
across **both** repos, applying the decisions below. This is a large pass — do it in **reviewable batches**,
verify after each, **commit per batch**, and **STOP and report** the moment anything unexpected happens.
Do **not** push.

---

## Decisions (these OVERRIDE the "choose one" wording in the report)

1. **CRITICAL — Moralis webhook idempotency** (report #1 / SEC #17, `moralis-handlers.ts:159`).
   Make the dedupe key **per-delivery**: `keccak256(rawBody)` (the existing fallback) — delete the
   `streamId_chainId_tag` branch. **Also process only `confirmed===true` events** (report SEC #18):
   ack-and-ignore unconfirmed deliveries (don't ingest them). Add a regression test proving two
   distinct deliveries are both processed and a replay of the same body dedupes.

2. **Refund flow** (report #5, #6, #22, #45, #46).
   - On refund → Stripe `cancel_at_period_end: true` **and** downgrade the local plan at period end
     (user keeps Pro until the paid period expires, then drops to Free).
   - **Refund window = 3 days**, as the **single source of truth** driven by the server `refundAvailable`
     flag. Remove the client-side `isEligible()` duplicates and the 7-day/3-day hardcodes; derive all UI
     copy from one constant.
   - Consolidate the **two refund UIs into one** entry point (don't keep a per-row affordance that hits
     an endpoint ignoring which payment was selected).
   - Add concurrency safety: Redis `SET NX` cooldown, set `refundAvailable=false` in DB **before** the
     Stripe call, and pass `idempotencyKey: refund:<paymentId>` to Stripe.

3. **`VITE_MOCK_AUTH`** (report #21, #35, SEC #6) — **remove the bypass entirely.** Delete the mock-auth
   path in `Neonfi/src/hooks.server.ts`, `(dashboard)/+layout.ts`, `(onboarding)/onboarding/+page.ts`,
   and the `.env` line. Local dev uses the real auth flow.

4. **Transfer destination-token picker** (report #7, `AddTransactionModal.svelte`) — **remove it** and its
   state (unused feature). Transfers stay same-token.

5. **`avatarUrl` in `PATCH /users/me`** (report SEC #4/#23) — **drop `avatarUrl` from `PatchMeSchema`.**
   Avatars are set only via `POST /users/me/avatar` (retrofit-90) and cleared via `DELETE`. (If a clear
   path via PATCH is still wanted, accept only `null`.)

6. **Docs divergences** (report #23–#33 + docs section) — **update the docs to match the as-built code**
   (schema PK/uniqueness/nullability, WS firehose per retrofit-28, `GET /auth/google`, etc.).
   **Exception:** where the as-built diverged in a way that is a **security risk** or the spec describes a
   **genuinely more efficient / better** approach, change the **code** to match the doc instead. Judge per
   item; default is docs→as-built. Docs live as `Neonfi/docs/*.txt` + `*_Build_Guide.md` (the `.docx`
   originals mirror these).

7. **Security — include ALL of it** (scope is everything). At minimum:
   - Global IP rate limiting (Redis sliding-window on a trusted client IP), mounted in `app.ts`, with
     tighter buckets on `/auth/*` mutations + provider-fanout routes (`/wallet/preview`, refund).
   - CSRF protection for cookie-authed writes (double-submit token or required custom header + Origin/Referer allowlist).
   - CSP + security headers (`frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS) — see allowlist note below.
   - Refresh-token rotation + reuse detection (revoke session family on reuse).
   - JWT `algorithms: ['HS256']` pinning in `jwt.ts`.
   - Error-message lockdown: global `onError` always returns a generic message; gate verbose bodies behind an explicit `DEBUG_ERRORS` flag (not `NODE_ENV`).
   - `bodyLimit` on `/webhooks/*`; Zod-validate Moralis payloads; guard `BigInt(...)` on untrusted strings as deterministic skips.
   - Per-IP dimension on login lockout (don't allow targeted per-email lockout DoS); dummy-hash compare to kill timing enumeration.

8. **Scope & ownership:** all 470, both repos, one coordinated effort.

---

## Execution protocol (follow exactly)

Work in **batches**, in this order, committing after each green batch:

1. **CRITICAL** — Moralis idempotency + confirmed-only (decision 1) + its regression test.
2. **Security — High/Critical** (rate limiting, refund-revoke, mock-auth removal, etc.).
3. **Security — Medium/Low** (CSRF, CSP/headers, JWT pin, error lockdown, bodyLimit, lockout, BigInt guards, avatarUrl drop…).
4. **Performance** (overview double-fetch, Redis pipelining, SCAN-not-KEYS, indexes + migrations, reprice scoping, FE chart-geometry decoupling, FE firehose coalescing, FE load decoupling, wallet N+1 bulk endpoint).
5. **Backend code quality** (CMC dedup `pickBestEntry`, the 5× "subscription effectively active" predicate → one shared helper, streams `res.ok`, `/health`, dead code, hardcoded values).
6. **Frontend code quality** (refund consolidation, transfer-token removal, dup/dead UI logic, hardcoded styles → tokens).
7. **Docs reconciliation** (decision 6).

**After every batch:**
- Backend: `npm run typecheck` → `npm run check:singletons` → `npx vitest run` (at least the affected suites; full suite before the final commit). All green.
- Frontend: `npm run check` (svelte-check, 0 errors). Build if practical.
- Commit with a clear message referencing the finding cluster (e.g. `fix(security): per-IP rate limiting + JWT alg pin (audit SEC #20,#27,#2)`). **Do not push.**

**STOP and report to Idowu (do not improvise further) when:**
- A previously-passing test fails and the correct fix isn't obvious.
- A change would alter a public API/response contract beyond what the finding describes.
- A DB migration is required — write the hand-authored migration, **list it for review**, and do **not** auto-reset/seed the database.
- A finding looks like a false-positive or contradicts another finding — flag it instead of guessing.
- Any behavioral change is ambiguous or could affect money/billing correctness.

One migration per schema change (`prisma/migrations/<ts>_<name>/migration.sql` + `prisma generate`); keep schema ↔ migration in lockstep.

---

## Guardrails — do NOT regress this session's recent work

The following shipped very recently (some may be uncommitted in the working tree). When a finding touches
these files, **preserve the new behavior** and fold the fix in rather than reverting:

- **Frontend:** chart zoom/pan (`src/lib/chart-zoom-pan.ts`, `AreaChart.svelte`, dashboard/performance/token charts); avatar upload (`TopBar.svelte`, `Sidebar.svelte`, `settings/+page.svelte`+`.ts`, `api.ts`, `endpoints.ts`, `(dashboard)/+layout.*`); `formatMoney` 2dp on aggregate figures (`format.ts`, dashboard/performance/wallet); settings portfolio asset counts; removed Account ID field; SA manual/CSV toggle sizing.
- **Backend:** retrofit-90 avatar R2 (`storage.ts`, `config.ts`, `users/avatar.ts`, `users.controller.ts`); retrofit-88 (per-portfolio all-time PnL in `portfolios.dto.ts`, duplicate-wallet 409). The performance finding #16/#17 (decouple static chart geometry from the live tip) **must keep zoom/pan working** — coordinate the two.

The **frontend NUMBER-formatting rule** (already applied, keep it): aggregate USD → `formatMoney` (2dp);
token prices / per-asset values → `formatPrice` (8 significant figures). Don't "fix" per-token values to 2dp.

---

## Action items for Idowu only (NOT CC)

- **Rotate the Neon Postgres password** — report SEC #37 flags live `DATABASE_URL`/`DIRECT_URL` in the
  **frontend** `.env`. CC should delete those two lines from `Neonfi/.env`; **you** rotate the credential in Neon.
- **CSP allowlist** — before enabling CSP, confirm the `img-src`/`connect-src` allowlist: `images.neonfi.live`
  (R2), Stripe, and any provider image hosts (Moralis/IPFS gateway). CC can scaffold CSP but you confirm hosts.
- Decide whether security headers go in-app (`kit.csp`) or at `nginx.conf` (CC will do whichever you point it to).

---

## Done = 

- Every report finding either fixed or, if intentionally skipped/deferred, marked as such with a one-line reason.
- Both repos: typecheck/`npm run check` clean, test suites green, build green.
- The Critical has a regression test; refund/billing changes have tests.
- Docs updated per decision 6; a short CHANGELOG (or appended section in the audit report) records what was fixed vs deferred.
