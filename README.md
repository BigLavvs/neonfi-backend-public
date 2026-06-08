<!--
  DELIBERATE DEPARTURE FROM System_Implementation §1.1 / Repository Structure.
  The docs mandate a monorepo (`neonfi/packages/{frontend,backend}`). This backend
  instead lives in a SEPARATE SIBLING REPOSITORY next to the already-built,
  already-deployed SvelteKit frontend (which is not ours to restructure). This was
  GATE A option (b), chosen explicitly by the repo owner. The frontend and backend
  are independently deployed Coolify resources regardless, so a sibling repo is a
  clean fit; the only cost is that the `packages/*` workspace layout from the docs
  is not realized here. Future readers: this is intentional, not an oversight.
-->

# Neonfi Backend

Hono + TypeScript API and (future) WebSocket server for Neonfi. **This repo currently contains Part 1 (Foundations) only** — project skeleton, env/config, Prisma schema + seed, shared client singletons, and the `/health` + `/api/v1/_ping` endpoints. No feature-stage endpoints exist yet (auth, users, subscriptions, portfolios, etc. are Stages 1–15).

Authoritative docs live in the frontend repo's `docs/`: `Neonfi_Backend_Build_Guide.md`, `Neonfi Database Schema.docx`, `Neonfi System Architecture.docx`, `Neonfi System Implementation.docx`. When this code and a doc disagree, the doc wins (Build Guide §0.1).

## Gate decisions recorded for this build

| Gate | Decision |
|---|---|
| **A — Repo structure** | **(b) Sibling backend repo.** Separate repo beside the frontend; deviation from §1.1 noted in the HTML comment at the top of this file. |
| **B — Chain seed** | **Skipped.** The 15 supported chains and which 3 are free-tier are not enumerated in any doc (Appendix item 1). `chain` table left empty with a TODO in `prisma/seed.ts`; do not invent the list. |
| **C — `name` vs `displayName`** | **Backend returns `displayName`; the frontend does the `name = displayName ?? fullName` fallback.** No `name` column, no synthesized `name` field. Recorded as a TODO in `src/modules/users/users.contract.ts`. Not implemented in Part 1. |
| **D — `emailVerified`** | **Derived server-side** as `onboardingStatus.name !== 'pending_verification'`; **no schema column added** (schema stays character-for-character identical to the docx). Caveat about future email-re-verification recorded in `src/modules/users/users.contract.ts`. Not implemented in Part 1. |

## Stack

Node.js ≥18 · Hono · TypeScript (ESM, strict) · Prisma (PostgreSQL + TimescaleDB on Neon) · ioredis (self-hosted Redis) · Zod · dotenv · Vitest. Dev runner: `tsx`.

## Layout

```
src/
  index.ts                 # Hono entry: /health + /api/v1 sub-app (_ping). WS NOT started (Stage 10).
  lib/
    config.ts              # Zod env loader, fail-fast. Import config from here; never read process.env elsewhere.
    prisma.ts              # single shared PrismaClient (pooled DATABASE_URL)
    redis.ts               # single shared ioredis client
    health.ts              # DB + Redis probe used by /health
    envelope.ts            # { data, meta? } / { error: { code, message } } helpers
    coinbase.ts            # placeholder (Stage 10)
  modules/                 # auth, users, subscriptions, portfolios, assets, transactions,
                           # nfts, tokens, chains, price, analytics, snapshots, webhooks, email
                           # (controllers/services land in their Part 3 stage; users/ holds Gate C/D notes)
  jobs/                    # snapshot.job.ts, token-sync.job.ts (placeholders)
  ws/                      # server.ts, registry.ts (placeholders)
prisma/
  schema.prisma            # verbatim from the schema docx; dual-URL datasource; FK indexes
  seed.ts                  # 8 lookup tables (chain + token intentionally empty)
  sql/
    001_timescaledb_hypertable.sql   # raw-SQL hypertable conversion (runs after migrate deploy, on DIRECT_URL)
    run-hypertable.ts                # runner for the above (DIRECT_URL)
scripts/
  check-singletons.mjs     # build-time guard: no PrismaClient/Redis constructed outside src/lib/
tests/                     # empty (Vitest, later stages)
```

## Setup

```bash
npm install
cp .env.example .env        # then fill in every required var (the loader fails fast if any is missing)
npm run prisma:generate     # generate the Prisma client
```

`.env` requires the **Neon dual URL**: `DATABASE_URL` is the **pooled** (`-pooler`) string used at runtime by Prisma Client; `DIRECT_URL` is the **direct** (non-pooled) host used by migrations and the hypertable conversion. Both are required.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with `tsx watch` (http://localhost:3000). |
| `npm run build` | Singleton guard + `tsc` → `dist/`. |
| `npm start` | Run the built server (`node dist/index.js`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run prisma:validate` | Validate `schema.prisma` (no DB needed). |
| `npm run migrate:dev` | `prisma migrate dev` — create/apply the initial migration (needs DB). |
| `npm run migrate:deploy` | `prisma migrate deploy` — apply migrations in CI/CD/prod. |
| `npm run db:hypertable` | Run the TimescaleDB hypertable conversion on `DIRECT_URL` **after** `migrate:deploy`. |
| `npm run db:seed` | Seed the 8 lookup tables (`prisma db seed`). |
| `npm test` | `vitest run` (no tests yet). |

### First-time DB bring-up (against a Neon dev branch)

```bash
npm run migrate:dev -- --name initial   # relational tables
npm run db:hypertable                    # CREATE EXTENSION timescaledb + create_hypertable('balance_snapshot','snapshot_date')
npm run db:seed                          # lookup rows
```

Verify the hypertable: `SELECT * FROM timescaledb_information.hypertables;` (or `\d+ balance_snapshot`).

## Endpoints (Part 1)

- `GET /health` — `200 { data: { status:'ok', db:'up', redis:'up' } }` when DB **and** Redis are up; `503 { error: { code:'HEALTH_FAILED', message } }` otherwise. **Not** under `/api/v1` (Coolify polls it directly). Coinbase is checked in `/ws/health` at Stage 10, not here.
- `GET /api/v1/_ping` — `200 { data: { ok: true } }`. Placeholder proving the base path; deleted when Stage 1 lands.

## Deploy flow (CD, for later)

Per `System_Implementation` Deployment Flow: install → `prisma migrate deploy` → run the hypertable conversion if not applied (`npm run db:hypertable`) → `npm run build` → `npm start`. CI/CD workflow files are not included in Part 1 (deferred; would target this repo, not a monorepo root).

## Out of scope for Part 1

Feature-stage endpoints; auth/session; WS server; Coinbase client; token-vendor selection; chain list; TimescaleDB compression/continuous-aggregates/retention; Prometheus/Grafana; object storage; load balancer/queues. See Build Guide §4 ("What NOT to do") and Parts 3–6.
