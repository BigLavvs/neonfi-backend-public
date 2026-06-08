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
import { Hono } from 'hono';

import { config, isProduction } from './lib/config.js';
import { checkHealth } from './lib/health.js';
import { err, ok } from './lib/envelope.js';

const app = new Hono();

// --- Health (NOT under /api/v1: Coolify polls it directly — §6.4/§6.8) --------
// 200 { data: { status:'ok', db, redis } } only when DB + Redis are both up;
// otherwise 503 { error: { code:'HEALTH_FAILED', message } } with a generic
// message and no stack trace.
app.get('/health', async (c) => {
  const health = await checkHealth();
  if (health.ok) {
    return c.json(ok({ status: 'ok', db: health.db, redis: health.redis }), 200);
  }
  return c.json(err('HEALTH_FAILED', health.failure ?? 'dependency unavailable'), 503);
});

// --- /api/v1 base-path sub-app (§2.1) ----------------------------------------
// Single placeholder to prove the base path is wired. DELETE _ping when Stage 1
// lands. No feature-stage endpoints exist in Part 1.
const api = new Hono();

api.get('/_ping', (c) => c.json(ok({ ok: true }), 200));

app.route('/api/v1', api);

// --- Errors & 404: standard envelopes, no stack traces (§2.3) -----------------
app.notFound((c) => c.json(err('NOT_FOUND', 'Resource not found'), 404));

app.onError((e, c) => {
  // Log full detail server-side; never return a stack trace to the client.
  // eslint-disable-next-line no-console
  console.error('[error]', e);
  const message = isProduction ? 'Internal server error' : e.message;
  return c.json(err('INTERNAL_ERROR', message), 500);
});

// --- Start ------------------------------------------------------------------
// The WS server is intentionally NOT started in Part 1 (see src/ws/server.ts,
// TODO Stage 10).
const port = 3000;
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[neonfi-backend] listening on http://localhost:${info.port} (NODE_ENV=${config.NODE_ENV})`);
});

export { app };
