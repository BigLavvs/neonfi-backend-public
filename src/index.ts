// =============================================================================
// Neonfi backend — application entry (Part 1: Foundations).
//
// SOURCE-OF-TRUTH HIERARCHY (Build Guide §0.1): 1) Neonfi_Database_Schema,
// 2) Neonfi_System_Architecture, 3) Neonfi_System_Implementation, 4) the frontend
// codebase (for consumed shapes), 5) the Build Guide (sequencing only). When they
// disagree, the higher source wins — STOP and flag, never silently diverge.
//
// PRIME DIRECTIVE (§0.2): divergence is worse than failure. A backend that fails
// loudly is recoverable; one that silently diverges from the documented contract
// ships a bug into a frontend already built against the documented shape.
//
// LOCKED GLOBAL DECISIONS (§0.4) — not ours to re-decide:
//   - IDs: Int autoincrement everywhere. No UUIDs.
//   - Enums are lookup TABLES (id + name + relation), not native Postgres enums;
//     the wire sends/receives the `name` string ("free", "connected", "native"…).
//   - Naming: camelCase fields, @@map("snake_case") tables.
//   - Auth: HttpOnly cookie named `session` for REST; single-use ticket for WSS.
//     Clients set no Authorization header.
//   - Money: Int minor units (e.g. cents). Crypto quantities: Decimal(20,8);
//     market cap: Decimal(30,2). Never floats.
//   - Plan enforcement is ALWAYS server-side; frontend gating is UX only.
//   - Derived values (PnL, totalValue, asset value/percentage, analytics) are
//     NEVER columns — computed at query time, cached in Redis.
//   - Validation: Zod, server-side, on every endpoint.
//   - Response envelopes: success { data, meta? }; error { error: { code, message } }.
//     Never leak stack traces.
//   - Module isolation: each module owns its tables; cross-module calls go
//     through exposed services only — no cross-module direct DB queries.
//
// CROSS-CUTTING CONTRACTS already wired at the skeleton (Part 2): REST base path
// is /api/v1 (§2.1); envelopes per §2.3. Auth (§2.2) and the WS server are NOT
// implemented in Part 1.
// =============================================================================

import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { config } from './lib/config.js';
import { app } from './app.js';
import { startTokenSyncScheduler } from './jobs/token-sync.job.js';
import { startSnapshotScheduler } from './jobs/snapshot.job.js';
import { startDbKeepalive, stopDbKeepalive } from './jobs/db-keepalive.job.js';
import { coinbase, fetchCoinbaseUsdBaseSymbols } from './lib/coinbase.js';
import { binance } from './lib/binance.js';
import { kraken, krakenBbo } from './lib/kraken.js';
import { loadCatalogSymbols, getCatalogSymbols, getKrakenCoverage } from './lib/price-symbols.js';
import { startWsServer } from './ws/server.js';

// --- Start ------------------------------------------------------------------
const port = 3000;
const server = serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[neonfi-backend] listening on http://localhost:${info.port} (NODE_ENV=${config.NODE_ENV})`);
}) as unknown as HttpServer;

if (config.NODE_ENV !== 'test') {
  startTokenSyncScheduler();
  startSnapshotScheduler();
  // OPTIONAL keep-alive (retrofit-17, default OFF) — gated so it only runs when an
  // operator opts in. Starts after the schedulers; the DB is reachable on demand
  // (the prisma retry extension absorbs a cold-start on the first ping).
  if (config.DB_KEEPALIVE_ENABLED) {
    startDbKeepalive();
  } else {
    console.log('[db-keepalive] disabled by DB_KEEPALIVE_ENABLED (default off)');
  }
  coinbase.connect();
  void startWsServer(server);
  void startPriceFeeds();
}

// --- Multi-exchange price ingestion boot (retrofit-16) ------------------------
// Build the normalization working set from the Token table, then connect the
// per-exchange feeds and subscribe each to its coverage set. Every feed is
// wrapped so a single one failing to connect never blocks boot or the others.
// The resolver (price-resolver.ts) owns the canonical `price:<SYMBOL>` write.
async function startPriceFeeds(): Promise<void> {
  try {
    await loadCatalogSymbols();
  } catch (e) {
    console.error('[neonfi-backend] failed to load price catalog; price feeds limited', e);
    return;
  }

  // Coinbase breadth coverage (best-effort): intersect the catalog with
  // Coinbase's listed USD products so we don't subscribe dead products.
  // retrofit-31: if that REST product list is empty/unreachable the old code
  // subscribed NOTHING — fall back to the catalog directly (Coinbase silently
  // ignores unknown products) so coverage can never silently become a no-op.
  // Emit one boot-summary line so the running process's feed wiring is visible.
  try {
    const coinbaseListed = await fetchCoinbaseUsdBaseSymbols();
    const catalog = [...getCatalogSymbols()];
    const coverage = coinbaseListed.size > 0
      ? catalog.filter((s) => coinbaseListed.has(s))
      : catalog; // fallback: REST product list unavailable — subscribe the catalog directly
    if (coinbaseListed.size === 0) {
      console.warn(JSON.stringify({ event: 'coinbase_products_unavailable_fallback', coverage: coverage.length }));
    }
    console.log(JSON.stringify({
      event: 'price_feeds_boot',
      binanceEnabled: config.BINANCE_ENABLED,
      catalog: getCatalogSymbols().size,
      coinbaseListed: coinbaseListed.size,
      coinbaseCoverage: coverage.length,
      krakenCoverage: getKrakenCoverage().length,
    }));
    coinbase.subscribeForCoverage(coverage);
  } catch (e) {
    console.error('[neonfi-backend] coinbase coverage subscribe failed', e);
  }

  // Binance — one all-market stream covers the whole catalog. Region-gated by
  // server egress IP; BINANCE_ENABLED=false degrades to Coinbase + Kraken.
  try {
    if (config.BINANCE_ENABLED) {
      binance.connect();
    } else {
      console.log('[neonfi-backend] BINANCE_ENABLED=false — skipping Binance feed');
    }
  } catch (e) {
    console.error('[neonfi-backend] binance connect failed', e);
  }

  // Kraken — no all-market stream; subscribe the top-N catalog USD pairs by rank. The bbo-mid
  // sub-feed covers the SAME pairs; the resolver uses it only when it's more current than the
  // last trade (retrofit-35).
  try {
    kraken.connect();
    kraken.subscribe(getKrakenCoverage());
    krakenBbo.connect();
    krakenBbo.subscribe(getKrakenCoverage());
  } catch (e) {
    console.error('[neonfi-backend] kraken connect failed', e);
  }
}

// --- Graceful shutdown (A19) -------------------------------------------------
// Coolify sends SIGTERM on container stop. Without these handlers WS connections,
// the Coinbase feed, and the Redis subscriber drop without unsubscribe, leaving
// orphan `subs:<SYMBOL>` SET entries the next process can't clean up. Each close
// is wrapped so one failure can't block the rest of the shutdown chain.
async function shutdown(signal: string): Promise<void> {
  console.log(`[neonfi-backend] received ${signal}, shutting down gracefully`);

  // Lazy imports — only loaded when shutdown fires; avoids forcing module load
  // order at boot and lets tests skip the shutdown machinery entirely.
  const { stopWsServer } = await import('./ws/server.js');
  const { redis } = await import('./lib/redis.js');
  const { prisma } = await import('./lib/prisma.js');

  // Stop the keep-alive heartbeat first so no ping fires after $disconnect below.
  try {
    stopDbKeepalive();
  } catch (e) {
    console.error('[neonfi-backend] stopDbKeepalive error:', e);
  }

  try {
    await stopWsServer();
  } catch (e) {
    console.error('[neonfi-backend] stopWsServer error:', e);
  }

  try {
    coinbase.disconnect();
  } catch (e) {
    console.error('[neonfi-backend] coinbase disconnect error:', e);
  }

  try {
    binance.disconnect();
  } catch (e) {
    console.error('[neonfi-backend] binance disconnect error:', e);
  }

  try {
    kraken.disconnect();
  } catch (e) {
    console.error('[neonfi-backend] kraken disconnect error:', e);
  }

  try {
    krakenBbo.disconnect();
  } catch (e) {
    console.error('[neonfi-backend] krakenBbo disconnect error:', e);
  }

  try {
    server.close();
  } catch (e) {
    console.error('[neonfi-backend] http server close error:', e);
  }

  try {
    await redis.quit();
  } catch (e) {
    console.error('[neonfi-backend] redis quit error:', e);
  }

  try {
    await prisma.$disconnect();
  } catch (e) {
    console.error('[neonfi-backend] prisma disconnect error:', e);
  }

  console.log('[neonfi-backend] shutdown complete');
  process.exit(0);
}

if (config.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export { app };
