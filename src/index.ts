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
import { coinbase } from './lib/coinbase.js';
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
  coinbase.connect();
  void startWsServer(server);
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
