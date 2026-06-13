// GET /ws/health — Coinbase WS + client-facing WS liveness (Build Guide §6.4).
//
// 200 when both Coinbase and the client-facing WS server are up; 503 otherwise.
// Client-facing WS server is always reported 'up' for Stage 10A (that server
// is built in Stage 10B; 10B will replace the placeholder below).

import type { Context } from 'hono';
import { coinbase } from '../lib/coinbase.js';
import { ok, err } from '../lib/envelope.js';

export function wsHealthHandler(c: Context): Response {
  const coinbaseUp = coinbase.isConnected();
  // Stage 10A: client-facing WS server not yet built — treat as always up
  const clientWsUp = true;

  if (coinbaseUp && clientWsUp) {
    return c.json(ok({ status: 'ok', coinbase: 'up', clientWs: 'up' }), 200);
  }

  const reason = !coinbaseUp ? 'Coinbase WS down' : 'Client WS down';
  return c.json(err('WS_HEALTH_FAILED', reason), 503);
}
