// GET /ws/health — Coinbase WS + client-facing WS liveness (Build Guide §6.4).
//
// 200 when both Coinbase and the client-facing WS server are up; 503 otherwise.

import type { Context } from 'hono';
import { coinbase } from '../lib/coinbase.js';
import { ok, err } from '../lib/envelope.js';
import { isWsServerRunning } from './server.js';

export function wsHealthHandler(c: Context): Response {
  const coinbaseUp = coinbase.isConnected();
  const wsServerUp = isWsServerRunning();

  if (coinbaseUp && wsServerUp) {
    return c.json(ok({ status: 'ok', coinbase: 'up', clientWs: 'up' }), 200);
  }

  const parts: string[] = [];
  if (!coinbaseUp) parts.push('coinbase');
  if (!wsServerUp) parts.push('clientWs');
  return c.json(err('WS_HEALTH_FAILED', `${parts.join(', ')} down`), 503);
}
