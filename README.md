# Neonfi Backend

Neonfi Backend is a TypeScript API and WebSocket service for a crypto portfolio application. It handles account authentication, subscription billing, portfolio and transaction data, connected-wallet ingestion, NFT holdings, analytics snapshots, token pricing, provider webhooks, and realtime price delivery.

This repository contains the backend service only. It is built with Hono, Prisma, PostgreSQL/TimescaleDB, Redis, Stripe, Moralis, and `ws`.

## Implemented Capabilities

- Email/password authentication, Google OAuth, refresh-token rotation, session listing and revocation, password reset, email verification, and single-use WebSocket tickets.
- User profile, preferences, avatar upload/delete support through S3-compatible object storage when configured.
- Free/pro subscription flows, Stripe checkout integration, refund initiation, payment history, and Stripe webhook reconciliation.
- Manual and connected portfolios, wallet preview, wallet resync, asset holdings, transaction CRUD, bulk transaction import, and cross-portfolio transfers.
- Chain and token catalog APIs, symbol validation, token history, historical price lookup, manual price refresh, and optional price-source diagnostics.
- Connected-wallet data ingestion through Moralis and fallback providers, including NFT holdings and spam classification.
- Portfolio snapshots, token price snapshots, analytics summaries, performance history, holdings allocation, and dashboard overview data.
- Pro-only WebSocket price stream using single-use Redis tickets and Redis pub/sub.
- Scheduled token metadata sync, connected-wallet repricing, live-price flush, daily snapshots, and optional database keepalive.

## Architecture

The service exposes a Hono REST API under `/api/v1`, with health probes at `/health` and `/ws/health`. `src/index.ts` starts the HTTP server, scheduled jobs, external price feeds, and the WebSocket upgrade handler. `src/app.ts` builds the Hono application and mounts route modules.

Principal data flows:

- Auth: browser receives HttpOnly `session` and `refresh` cookies; refresh tokens are stored only as SHA-256 hashes in the `session` table and rotated on refresh.
- Stripe: checkout and invoice events are signature-verified, claimed atomically in Redis by event ID, dispatched to subscription/payment handlers, and deduped for later duplicate delivery. If a handled event fails, the Redis claim is released so Stripe can retry.
- Moralis: webhook bodies are verified using the raw body and Moralis signature, structurally validated, deduped by raw-body hash after successful processing, and translated into connected portfolio updates.
- Prices: exchange and provider clients write canonical live prices into Redis; REST endpoints can refresh/read prices, scheduled jobs flush live prices into token rows, and WebSockets broadcast `price_update` frames to connected Pro clients.
- Snapshots: the daily snapshot job writes portfolio balance snapshots and token price snapshots. `balance_snapshot` is converted to a TimescaleDB hypertable after Prisma migrations.

## Stack

- Node.js 20+
- TypeScript, ESM, strict mode
- Hono on `@hono/node-server`
- Prisma with PostgreSQL and TimescaleDB
- Redis through `ioredis`
- Stripe SDK
- Moralis and wallet-data provider integrations
- `ws` WebSocket server
- Vitest

## Directory Structure

```text
src/
  app.ts                    Hono app factory, middleware, route mounting
  index.ts                  server boot, schedulers, price feeds, shutdown
  lib/                      config, Prisma/Redis singletons, security, providers
  modules/
    auth/                   auth controllers, schemas, service, plan middleware
    users/                  profile, sessions, avatar, preferences
    subscriptions/          plan state, checkout/downgrade/cancel/refund logic
    payments/               payment history APIs
    portfolios/             manual/connected portfolios and wallet sync
    assets/                 holdings CRUD and bulk import
    transactions/           transaction CRUD, transfers, balance recalculation
    nfts/                   NFT holdings and spam overrides
    tokens/                 catalog, token history, metadata sync
    chains/                 supported chain catalog
    prices/                 manual refresh, history, diagnostics
    snapshots/              snapshot APIs
    analytics/              performance and holdings analytics
    overview/               dashboard aggregate data
    webhooks/               Stripe and Moralis webhooks
    wallet-data/            provider adapters and connected-wallet sync
  jobs/                     scheduled background jobs
  ws/                       WebSocket server, registry, health probe
prisma/
  schema.prisma             database schema
  migrations/               Prisma migrations
  seed.ts                   lookup/catalog seed
  sql/                      TimescaleDB hypertable conversion
scripts/
  check-singletons.mjs      runtime client singleton guard
tests/                      Vitest integration and unit tests
```

## Prerequisites

- Node.js 20 or newer. `.nvmrc` pins the expected major version.
- PostgreSQL with TimescaleDB available for snapshot hypertables.
- Redis.
- Stripe account/configuration for checkout, billing, and webhook verification.
- Moralis Streams configuration for connected-wallet webhook ingestion.
- Optional provider credentials for catalog, historical price, wallet-data fallback, and avatar storage features.

## Environment Setup

Copy `.env.example` to `.env` for local development and fill in real values. Do not commit `.env`.

Environment variables are grouped by purpose:

- Core: `APP_BASE_URL`, `API_BASE_URL`, `NODE_ENV`, `PORT`, `LOG_LEVEL`.
- Database: `DATABASE_URL`, `DIRECT_URL`, `DATABASE_URL_TEST`.
- Redis: `REDIS_URL`, `REDIS_URL_TEST`.
- Auth/security: `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY`, `COOKIE_SECRET`, Google OAuth values, lockout/rate-limit/CSRF/debug flags.
- Billing: Stripe secret key, webhook secret, and price IDs.
- Web3/data providers: Moralis, CoinMarketCap, exchange WebSocket URLs, historical-price providers, wallet-data fallback providers.
- Email: Resend API key and sender address.
- Jobs: token sync, connected repricing, live-price flush, snapshot schedule, optional DB keepalive.
- Avatar storage: R2/S3-compatible endpoint, credentials, bucket, public URL, and upload cap.

When `NODE_ENV=test`, both `DATABASE_URL_TEST` and `REDIS_URL_TEST` are required. They must resolve to separate targets from `DATABASE_URL`, `DIRECT_URL`, and `REDIS_URL`. The app exits before creating Prisma or Redis clients if this isolation is missing or unsafe.

## Installation

```bash
npm ci
npm run prisma:generate
```

For first-time database setup:

```bash
npm run migrate:deploy
npm run db:hypertable
npm run db:seed
```

Use `migrate:dev` only when intentionally creating or iterating on migrations in a development database.

## Commands

```bash
npm run dev                 # start the TypeScript dev server
npm run build               # singleton check + TypeScript build
npm start                   # run dist/index.js
npm run typecheck           # tsc --noEmit
npm run check:singletons    # verify runtime clients are only constructed in src/lib
npm run prisma:validate     # validate Prisma schema
npm run migrate:dev         # development migration flow
npm run migrate:deploy      # apply existing migrations
npm run db:hypertable       # convert balance_snapshot to a TimescaleDB hypertable
npm run db:seed             # seed lookup tables and starter catalog data
npm test                    # run Vitest
```

Test cleanup truncates user-data tables and clears Redis-derived caches. Never point `DATABASE_URL_TEST` or `REDIS_URL_TEST` at a development, staging, or production target.

## API Route Groups

All API routes are under `/api/v1` unless noted. Most application routes require the session cookie; webhook routes use provider signatures instead.

- `/auth`: registration, login/logout, verification, password reset, refresh, Google OAuth, sessions, WebSocket ticket issuance.
- `/users`: current user profile, avatar, preferences, account deletion.
- `/subscriptions`: subscription creation, current subscription, upgrade, downgrade, cancellation, refund.
- `/payments`: authenticated payment history reads.
- `/chains`: supported chain catalog.
- `/tokens`: token list/detail/history and symbol validation.
- `/portfolios`: portfolio CRUD, connected-wallet preview and resync.
- `/portfolios/:portfolioId/assets`: asset CRUD and bulk asset operations.
- `/portfolios/:portfolioId/transactions`: transaction CRUD, transfer, bulk import, connected-history pagination.
- `/portfolios/:portfolioId/nfts`: NFT list/detail and spam override.
- `/portfolios/:portfolioId/snapshots`: portfolio snapshot history.
- `/prices`: manual refresh, price history, historical price lookup, optional debug data.
- `/analytics`: per-portfolio summary, performance, and holdings analytics.
- `/overview`: cross-portfolio dashboard aggregate and recent transactions.
- `/webhooks/stripe`: Stripe webhook endpoint.
- `/webhooks/moralis`: Moralis Streams webhook endpoint.
- `/health`: database, Redis, and Coinbase health probe.
- `/ws/health`: WebSocket/price-feed health probe.
- `/ws`: WebSocket upgrade path.

## WebSockets

Authenticated users request a single-use ticket from `GET /api/v1/auth/ws-token`. The WebSocket server consumes the Redis ticket with `GETDEL`, validates the session, checks the effective plan, and rejects free users at upgrade time. Connected Pro sockets receive broadcast `price_update` messages from Redis `price:*` pub/sub. Plan-change events close sockets when a user loses Pro access.

## Scheduled Jobs

Schedulers start only outside `NODE_ENV=test`.

- Token metadata sync: controlled by `TOKEN_SYNC_ENABLED` and `TOKEN_SYNC_CRON`.
- Connected-wallet repricing: controlled by `CONNECTED_REPRICE_ENABLED` and `CONNECTED_REPRICE_CRON`.
- Live-price flush: controlled by `LIVE_PRICE_FLUSH_ENABLED` and `LIVE_PRICE_FLUSH_CRON`.
- Daily snapshots: controlled by `SNAPSHOT_ENABLED` and `SNAPSHOT_CRON`; also performs a boot catch-up if today's token price snapshot is absent.
- DB keepalive: opt-in through `DB_KEEPALIVE_ENABLED`.

## Security Controls Present

- HttpOnly session and refresh cookies, with `Secure` enabled in production.
- Access-token verification against the database session row on authenticated routes.
- Refresh-token rotation with Redis reuse detection.
- Password hashing through `bcryptjs`.
- Login lockout and Redis-backed IP rate limits.
- CSRF Origin/Referer checks for cookie-authenticated mutating requests, excluding signature-verified webhooks.
- CORS restricted to `APP_BASE_URL` with credentials enabled.
- Security headers on all responses, including CSP, frame denial, nosniff, referrer policy, and production-only HSTS.
- Stripe and Moralis signature verification before webhook processing.
- Webhook body size limit before raw-body buffering.
- Redis idempotency for webhook delivery handling.
- Global error handler that returns generic internal errors unless `DEBUG_ERRORS=true`.
- Explicit opt-in for logging auth URLs with embedded one-time tokens.

## Deployment Notes

A deploy process should install dependencies, generate Prisma client code, apply migrations, run the TimescaleDB hypertable conversion, build, and start `dist/index.js`.

The service exposes `/health` for dependency health and `/ws/health` for WebSocket/price-feed health. External services must supply valid PostgreSQL/TimescaleDB, Redis, Stripe, Moralis, email, and provider configuration before affected features can operate.

## Known Limitations

- This backend depends on external provider availability and rate limits for wallet data, token metadata, historical prices, live exchange data, email, Stripe, and object storage.
- Some provider integrations are best-effort fallback paths and may skip unavailable providers when credentials are absent.
- Snapshot history only accrues after the snapshot jobs or backfill scripts run.
- `PRICE_DEBUG_ENABLED` defaults to true for existing behavior; disable it in deployed environments that should not expose price-source diagnostics to authenticated users.
- No repository license is included. License selection is an owner decision.

## CI

The repository includes a GitHub Actions workflow that is configured to run without production credentials. It provisions isolated TimescaleDB/PostgreSQL and Redis services, uses dummy third-party values, applies migrations to the test database, runs the hypertable conversion and seed, then runs singleton checks, type-checking, build, and tests.
