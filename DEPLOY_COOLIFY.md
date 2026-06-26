# Neonfi Backend + Redis — Coolify Deployment Runbook

Tailored to this repo (Hono + `@hono/node-server`, Prisma 6 + Neon Postgres, ioredis, `ws`,
Stripe, Moralis, Resend, Cloudflare R2). Frontend is already on Coolify (SvelteKit `adapter-static`).

---

## 0. The one decision that makes or breaks auth — read first

The backend sets the auth cookie as **`SameSite=Lax`** and has **no CORS middleware**. The static
frontend calls the API from the browser with `credentials: 'include'`. For that to work in production:

1. **Frontend and API must live on the same registrable domain**, as two subdomains. Example:
   - Frontend: `https://app.neonfi.live`  (already deployed)
   - Backend:  `https://api.neonfi.live`  (this deploy)
   A Coolify-generated random domain on a different root (e.g. `*.sslip.io`) will break login —
   the browser won't send the cookie cross-site. Use a real custom domain you own for both.

2. **You must add a small CORS middleware** (cross-subdomain is cross-*origin*). See Step 1.B. Without
   it the browser blocks every authenticated API response even though the cookie is same-site.

If you'd rather not touch backend code, the alternative is a same-origin reverse proxy (serve the API
under `app.neonfi.live/api/*` on the SAME domain). That needs no CORS and no code change, but it's a
fiddlier Coolify/Traefik setup. This runbook uses the **subdomain + CORS** path because it's simpler in
Coolify and each service stays independent.

---

## 1. Two required code changes before you deploy

### 1.A — Generate the Prisma client during build
`npm run build` is `check:singletons && tsc` — it does **not** run `prisma generate`, so the deployed
image would have no Prisma client. Add a `postinstall` hook (runs automatically on `npm ci`):

In `package.json`, add one line to `scripts`:
```json
"postinstall": "prisma generate",
```
(Alternatively, skip this and set the Coolify **Build Command** to
`npm ci && npx prisma generate && npm run build`. Pick one.)

### 1.B — Add CORS for the frontend origin
`src/app.ts`, near the top of `createApp()` (right after `const app = new Hono();`, before
`securityHeaders()`):

```ts
import { cors } from 'hono/cors';   // add with the other imports

// ...inside createApp(), first middleware:
app.use(
  '*',
  cors({
    origin: config.APP_BASE_URL,    // exact frontend origin, e.g. https://app.neonfi.live
    credentials: true,              // allow the session cookie
    allowHeaders: ['Content-Type', 'X-CSRF-Token'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);
```
`hono/cors` ships with Hono (no new dependency). `config.APP_BASE_URL` is the frontend URL you set in
env. Verify both build green locally before pushing:
```
npm run typecheck
npm run build
```

> Skip 1.B only if you go the same-origin reverse-proxy route instead.

---

## 2. Push the backend to GitHub

`.gitignore` already excludes `.env`, `.env.*`, `node_modules/`, `dist/` — your secrets won't be
committed. Confirm, then push.

```bash
cd C:\Users\pelum\Desktop\neonfi-backend

# 1. confirm .env is ignored (should print nothing):
git check-ignore .env   # if git not init yet this errors — that's fine, continue

# 2. init if this isn't a repo yet:
git init
git branch -M main

# 3. sanity check what WOULD be committed — make sure NO .env shows up:
git add -A
git status                # scan the list: .env / .env.* must NOT appear; .env.example MAY

# 4. commit
git commit -m "chore: backend ready for deploy (prisma generate on install + CORS)"
```

Create an **empty private** repo on GitHub (no README/license), then:
```bash
git remote add origin https://github.com/<you>/neonfi-backend.git
git push -u origin main
```

> If `git status` ever shows `.env`, STOP and run `git rm --cached .env` before committing — never push
> the filled-in env file.

---

## 3. Provision Redis in Coolify (do this BEFORE the backend)

The `/health` probe returns **503 until Redis is reachable**, so Redis must exist first.

1. Coolify → your Project/Environment → **+ New** → **Database** → **Redis** (Redis 7).
2. Put it in the **same Project/Environment** as the backend will be (so they share the internal
   Docker network).
3. Start it. Open the resource and copy its **internal connection URL** — it looks like:
   `redis://default:<password>@<service-name>:6379`
   Use the **internal** host (service name), not a public one. You'll paste this as `REDIS_URL`.
4. Leave it **not publicly exposed** (internal only) — the app reaches it over the Docker network.

---

## 4. Database (Neon) — nothing to "deploy", just decide which DB

Postgres is Neon (cloud), so you only supply connection strings.

- **Reuse your existing Neon DB** (the one your local `.env` points at): migrations + token catalog are
  already applied — you can skip the seed step. Simplest for shipping the MVP.
- **Or create a fresh Neon project/branch** for production: you'll run migrations + seeds in Step 7.

Two URLs, exactly as in `.env.example`:
- `DATABASE_URL` = **pooled** (`-pooler` host) **+ append** `&pgbouncer=true&connect_timeout=30&pool_timeout=20`
- `DIRECT_URL` = **direct** (non-pooled) host, **no** `pgbouncer` param (migrations need a direct conn).

> **TimescaleDB / hypertable:** the `npm run db:hypertable` step needs the `timescaledb` extension,
> which **Neon does not support — skip it.** `BalanceSnapshot` works fine as a regular table (that's
> what `migrate deploy` creates); the hypertable is only a time-series optimization.

---

## 5. Create the backend app in Coolify

1. Coolify → same Project/Environment → **+ New** → **Application** → **Private Repository (GitHub App)**
   (install the Coolify GitHub App on the repo if prompted) → pick `neonfi-backend`, branch `main`.
2. **Build pack: Nixpacks** (auto-detects Node). 
3. **Build Command:**
   - If you added `postinstall` (1.A): leave default, or set `npm run build`.
   - If you did NOT add postinstall: set `npm ci && npx prisma generate && npm run build`.
4. **Start Command:** `npm run start`  (runs `node dist/index.js`).
5. **Port:** `3000` (the app reads `PORT`, defaults to 3000; set `PORT=3000` in env too — Step 6).
6. **Health Check Path:** `/health`  ·  expected status `200`. (Returns 503 until DB+Redis are up —
   that's why Redis is deployed first.)

---

## 6. Environment variables (Coolify → the app → Environment Variables)

**Fastest path:** copy every line from your working local `.env` into Coolify, then override the
production-specific ones below. The Zod loader (`src/lib/config.ts`) fails fast (exit 1) on any missing
required var, so don't drop any.

**Override / set for production:**
```
NODE_ENV=production
PORT=3000

APP_BASE_URL=https://app.neonfi.live          # your frontend URL (exact origin)
API_BASE_URL=https://api.neonfi.live          # this backend's URL

DATABASE_URL=<neon POOLED url + &pgbouncer=true&connect_timeout=30&pool_timeout=20>
DIRECT_URL=<neon DIRECT url, no pgbouncer param>

REDIS_URL=redis://default:<password>@<redis-service-name>:6379   # internal URL from Step 3

GOOGLE_REDIRECT_URI=https://api.neonfi.live/api/v1/auth/google/callback
STRIPE_WEBHOOK_SECRET=<the signing secret of the NEW prod webhook you create in Step 10>
```

**Reuse verbatim from your local `.env` (required — app won't boot without them):**
`JWT_SECRET` (≥32 chars), `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY`, `COOKIE_SECRET`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PRO_MONTHLY_PRICE_ID`,
`STRIPE_PRO_YEARLY_PRICE_ID`, `MORALIS_API_KEY`, `MORALIS_WEBHOOK_SECRET`, `COINBASE_WS_URL`,
`COINMARKETCAP_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`.

> Recommended: generate **fresh** `JWT_SECRET` and `COOKIE_SECRET` for production rather than reusing
> dev values: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`

**Optional (set if you use them — you do for avatars):**
`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`
(remember the EU-jurisdiction `.eu.` endpoint caveat), and `COINGECKO_API_KEY` (chart backfill).

Everything else (`LOG_LEVEL`, all `*_ENABLED` flags, cron schedules, rate-limit numbers, exchange WS
URLs) has a safe default — only set them to override.

---

## 7. Run migrations (and seeds, only on a fresh DB)

Set a Coolify **Pre-deployment Command** on the app (runs in a one-off container with your env, before
the new version goes live):
```
npx prisma migrate deploy
```
That's idempotent — on your existing Neon DB it's a no-op; on a fresh DB it builds the schema.

**Only if you chose a FRESH Neon DB in Step 4**, also seed once. After the first successful deploy, open
the app's **Terminal/Exec** in Coolify and run:
```
npm run db:seed       # enum lookup tables (plan types, tx directions, etc.)
npm run seed:tokens   # token catalog (CoinMarketCap)
```
(Skip both if you reused your already-seeded dev DB. Do **not** run `db:hypertable` — see Step 4.)

---

## 8. Domain, HTTPS, WebSocket

1. App → **Domains**: add `https://api.neonfi.live`. In your DNS, point `api` (A/CNAME) at the Coolify
   host. Coolify provisions Let's Encrypt TLS automatically.
2. **WebSocket** needs no extra config: the app serves WS on the **same port** under `/ws`, and Coolify's
   Traefik proxy upgrades WebSocket connections on the same domain. `wss://api.neonfi.live/ws` will work
   once the domain is live.
3. Deploy. Watch logs for `"[neonfi-backend] listening on ..."` and the `price_feeds_boot` line. The
   Coolify health badge should go green (it's hitting `/health`).

---

## 9. Point the frontend at the new backend

In your **frontend** Coolify app → Environment Variables (these are build-time for `adapter-static`, so
you must **redeploy the frontend** after changing them):
```
VITE_API_URL=https://api.neonfi.live/api/v1     # IMPORTANT: include the /api/v1 segment
VITE_WS_URL=wss://api.neonfi.live               # no /api/v1; the client appends /ws
```
Trigger a frontend redeploy so the new values bake into the static build.

---

## 10. External services to update (post-deploy)

- **Stripe → Webhooks:** add endpoint `https://api.neonfi.live/api/v1/webhooks/stripe`, select the
  events you handle, copy its **Signing secret** into `STRIPE_WEBHOOK_SECRET` (Step 6) and redeploy.
- **Moralis → Streams:** point the stream/webhook at
  `https://api.neonfi.live/api/v1/webhooks/moralis` (the `MORALIS_WEBHOOK_SECRET` must match).
- **Google Cloud Console → OAuth client → Authorized redirect URIs:** add
  `https://api.neonfi.live/api/v1/auth/google/callback` (matches `GOOGLE_REDIRECT_URI`). Also add the
  frontend origin to Authorized JavaScript origins if required.

---

## 11. Smoke test (in order)

```bash
# 1. health (expect {"data":{"status":"ok","db":...,"redis":...}})
curl https://api.neonfi.live/health

# 2. ws health
curl https://api.neonfi.live/ws/health
```
Then in the browser on `https://app.neonfi.live`:
3. Register → check email (Resend) → verify → log in. Confirm you stay logged in on refresh (cookie OK).
4. Dashboard loads data; token prices ticking (WS connected — Pro).
5. Avatar upload (R2). 6. Stripe checkout in test mode → confirm webhook marks the subscription.

---

## 12. Troubleshooting (most common, in likelihood order)

| Symptom | Cause → Fix |
|---|---|
| Container won't start, logs show `[config] Invalid or missing environment variables` | A required env var is missing/blank → add it (Step 6). |
| Health stays red / `503 HEALTH_FAILED` | Redis (or DB) unreachable → check `REDIS_URL` uses the **internal** service name + password; ensure Redis is in the same Project/Environment. |
| Login succeeds but you're logged out on refresh / 401s | Cross-site cookie blocked → frontend and API must be **subdomains of one root domain**, and the CORS middleware (1.B) must allow `APP_BASE_URL` with `credentials:true`. |
| Browser console: CORS error | CORS not added (1.B) or `APP_BASE_URL` doesn't exactly match the frontend origin (scheme + host). |
| API calls 404 | `VITE_API_URL` missing the `/api/v1` suffix (Step 9). |
| `prisma` "client did not initialize" at runtime | `prisma generate` didn't run in build → add `postinstall` (1.A) or fix the Build Command. |
| First request after idle is slow / `P1001`/`P1017` | Neon free-tier cold start → ensure the `connect_timeout/pool_timeout/pgbouncer` params are on the **pooled** `DATABASE_URL`; optionally set `DB_KEEPALIVE_ENABLED=true` (uses more compute-hours). |
| `migrate deploy` fails on `timescaledb` | You ran `db:hypertable` — don't, on Neon (Step 4). |
| Stripe events not applied | Webhook URL/secret mismatch (Step 10). |

---

### Quick reference — build/run contract
- Install → `npm ci` (triggers `postinstall: prisma generate`)
- Build → `npm run build`  (`check:singletons` + `tsc` → `dist/`)
- Migrate (pre-deploy) → `npx prisma migrate deploy`  (uses `DIRECT_URL`)
- Start → `npm run start`  (`node dist/index.js`, serves HTTP + WS + `/health` on `PORT`)
- Stop → Coolify sends `SIGTERM`; the app drains WS/feeds/Redis/Prisma gracefully.
