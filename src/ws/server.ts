// Neonfi backend — client-facing WebSocket server (Stage 10B; retrofit-28 broadcast firehose).
//
// Upgrade-level auth: GETDEL ws_ticket:<token> from Redis (issued by GET /auth/ws-token).
// Build Guide §2.7: close code 4001 = consumed/invalid ticket; at upgrade time this
// manifests as HTTP 401 (no WS handshake has occurred yet — no socket to send a close
// frame to). HTTP 403 = free user rejected at handshake.
//
// retrofit-28 — BROADCAST FIREHOSE. Realtime prices are a client-side display overlay
// (Idowu's decision, see _claude/retrofit-28.md). The server no longer tracks per-socket
// symbol subscriptions; it psubscribes the full `price:*` channel ONCE, buffers the
// latest tick per symbol, and flushes ONE batched `price_update` frame to EVERY open
// (Pro) socket on a fixed ~1s cadence. No `subscribe` message, no `subs:<SYMBOL>` sets,
// no per-socket symbol state — server cost is flat regardless of symbol/holding count.
// The exchange feeds already subscribe full coverage at boot (index.ts startPriceFeeds),
// so prices are already flowing into Redis `price:<SYMBOL>`.

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { redis } from '../lib/redis.js';
import { redisSubscriber } from '../lib/redis-subscriber.js';
import { findSessionById } from '../modules/users/users.repository.js';
import { getEffectivePlan } from '../modules/subscriptions/subscriptions.service.js';
import {
  socketsByUser,
  wsBySocketId,
  registerSocket,
  unregisterSocket,
  clearRegistry,
} from './registry.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _wss: WebSocketServer | null = null;

// retrofit-28: latest tick per symbol, accumulated between flushes (latest wins). One
// shared buffer for the whole process — the broadcast is identical for every socket.
const priceBuffer = new Map<string, { price: number; change24h: number }>();

// Single batching timer: one client update/sec (smooth, low churn) instead of per-tick
// spam. Cleared in stopWsServer.
let _flushTimer: ReturnType<typeof setInterval> | null = null;
const FLUSH_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isWsServerRunning(): boolean {
  return _wss !== null;
}

export async function startWsServer(httpServer: HttpServer): Promise<void> {
  if (_wss) return;

  _wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req: IncomingMessage, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws') return;

    const result = await authorizeUpgrade(req);
    if (!result.ok) {
      socket.write(`HTTP/1.1 ${result.status} ${result.statusText}\r\n\r\n`);
      socket.destroy();
      return;
    }

    _wss!.handleUpgrade(req, socket, head, (ws) => {
      _wss!.emit('connection', ws, req, result.context);
    });
  });

  _wss.on('connection', handleConnection);

  await startRedisSubscriptions();
  startFlushLoop();
}

export async function stopWsServer(): Promise<void> {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  priceBuffer.clear();

  for (const ws of wsBySocketId.values()) {
    ws.terminate();
  }
  clearRegistry();

  // Best-effort subscription cleanup, then force the connection down. We do NOT await the
  // unsubscribe/punsubscribe round-trips — disconnect() tears the connection down
  // regardless, and a slow round-trip must not block (or hang) shutdown.
  try {
    void redisSubscriber.unsubscribe().catch(() => {});
    void redisSubscriber.punsubscribe().catch(() => {});
    redisSubscriber.disconnect();
  } catch {
    // ignore cleanup errors
  }

  if (_wss) {
    await new Promise<void>((r, e) =>
      _wss!.close((err) => (err ? e(err) : r())),
    );
    _wss = null;
  }
}

// ---------------------------------------------------------------------------
// Upgrade authorisation
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: number;
  sessionId: number;
}

type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: number; statusText: string };

async function authorizeUpgrade(req: IncomingMessage): Promise<AuthResult> {
  const url = new URL(req.url!, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    return { ok: false, status: 401, statusText: 'Unauthorized' };
  }

  // Single-use: GETDEL atomically reads and deletes the ticket.
  // A null return means absent, expired, or already consumed.
  const value = await redis.getdel('ws_ticket:' + token);
  if (!value) {
    return { ok: false, status: 401, statusText: 'Unauthorized' };
  }

  const [userIdStr, sessionIdStr] = value.split(':');
  const userId = parseInt(userIdStr ?? '', 10);
  const sessionId = parseInt(sessionIdStr ?? '', 10);

  if (!userId || isNaN(userId) || !sessionId || isNaN(sessionId)) {
    return { ok: false, status: 401, statusText: 'Unauthorized' };
  }

  const session = await findSessionById(sessionId);
  if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
    return { ok: false, status: 401, statusText: 'Unauthorized' };
  }

  const plan = await getEffectivePlan(userId);
  if (plan === 'free') {
    return { ok: false, status: 403, statusText: 'Forbidden' };
  }

  return { ok: true, context: { userId, sessionId } };
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function handleConnection(ws: WebSocket, _req: IncomingMessage, context: AuthContext): void {
  const socketId = randomUUID();
  const { userId } = context;

  registerSocket(socketId, userId, ws);

  // retrofit-28: clients send nothing now (the firehose delivers everything). Inbound
  // frames are ignored — drain them so the socket buffer doesn't grow, but never reply.
  ws.on('message', () => {
    /* ignore — broadcast firehose has no client→server protocol */
  });

  ws.on('close', () => {
    unregisterSocket(socketId, userId);
  });

  ws.on('error', (err: Error) => {
    console.error('[ws] socket error', err.message);
  });
}

// ---------------------------------------------------------------------------
// Price firehose — buffer + batched flush
// ---------------------------------------------------------------------------

function startFlushLoop(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(flushPrices, FLUSH_INTERVAL_MS);
  // Don't let the batching timer keep the process alive on its own; the HTTP server
  // (prod) / test harness owns the event loop. Guarded for runtimes lacking unref.
  _flushTimer.unref?.();
}

function bufferPrice(channel: string, raw: string): void {
  const symbol = channel.slice('price:'.length);
  if (!symbol) return;
  let data: { price?: unknown; change24h?: unknown };
  try {
    data = JSON.parse(raw) as { price?: unknown; change24h?: unknown };
  } catch {
    return;
  }
  if (typeof data.price !== 'number' || !Number.isFinite(data.price)) return;
  const change24h =
    typeof data.change24h === 'number' && Number.isFinite(data.change24h) ? data.change24h : 0;
  // Latest tick wins until the next flush.
  priceBuffer.set(symbol, { price: data.price, change24h });
}

function flushPrices(): void {
  if (priceBuffer.size === 0) return;

  const prices = [...priceBuffer.entries()].map(([symbol, { price, change24h }]) => ({
    symbol,
    price,
    change24h,
  }));
  priceBuffer.clear();

  const msg = JSON.stringify({
    type: 'price_update',
    payload: { prices },
    timestamp: new Date().toISOString(),
  });

  for (const ws of wsBySocketId.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis pub/sub
// ---------------------------------------------------------------------------

async function startRedisSubscriptions(): Promise<void> {
  // Control-plane channels (exact) + the price firehose pattern (one psubscribe for
  // every symbol). Both ride the single dedicated subscriber connection.
  await redisSubscriber.subscribe('user_events', 'client_events');
  await redisSubscriber.psubscribe('price:*');

  redisSubscriber.on('message', (channel: string, raw: string) => {
    void (async () => {
      try {
        if (channel === 'user_events') {
          await handleUserEvent(raw);
        } else if (channel === 'client_events') {
          await handleClientEvent(raw);
        }
      } catch (e) {
        console.error('[ws] pub/sub handler error', e instanceof Error ? e.message : e);
      }
    })();
  });

  redisSubscriber.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    if (channel.startsWith('price:')) bufferPrice(channel, raw);
  });
}

async function handleUserEvent(raw: string): Promise<void> {
  let evt: { type: string; userId: number };
  try {
    evt = JSON.parse(raw) as { type: string; userId: number };
  } catch {
    return;
  }

  if (evt.type !== 'plan_changed') return;

  const newPlan = await getEffectivePlan(evt.userId);
  if (newPlan !== 'free') return;

  const socketIds = socketsByUser.get(evt.userId) ?? new Set<string>();
  for (const sid of socketIds) {
    const ws = wsBySocketId.get(sid);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    ws.send(
      JSON.stringify({
        type: 'plan_downgraded',
        payload: { message: 'Your Pro subscription has expired' },
        timestamp: new Date().toISOString(),
      }),
    );
    ws.close(4003, 'Plan downgraded');
  }
}

async function handleClientEvent(raw: string): Promise<void> {
  let evt: { type: string; payload: Record<string, unknown> };
  try {
    evt = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
  } catch {
    return;
  }

  if (evt.type !== 'reconnect') return;

  const msg = JSON.stringify({
    type: 'reconnect',
    payload: evt.payload,
    timestamp: new Date().toISOString(),
  });

  for (const ws of wsBySocketId.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
