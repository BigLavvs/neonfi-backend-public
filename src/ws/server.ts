// Neonfi backend — client-facing WebSocket server (Stage 10B).
//
// Upgrade-level auth: GETDEL ws_ticket:<token> from Redis (issued by GET /auth/ws-token).
// Build Guide §2.7: close code 4001 = consumed/invalid ticket; at upgrade time this
// manifests as HTTP 401 (no WS handshake has occurred yet — no socket to send a close
// frame to). HTTP 403 = free user rejected at handshake.
//
// Fan-out path: Coinbase → Redis publish price:<SYMBOL> → redisSubscriber → subs:<SYMBOL>
// SET members → wsBySocketId map → ws.send(price_update envelope).

import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { redis } from '../lib/redis.js';
import { redisSubscriber } from '../lib/redis-subscriber.js';
import { coinbase } from '../lib/coinbase.js';
import { findSessionById } from '../modules/users/users.repository.js';
import { getEffectivePlan } from '../modules/subscriptions/subscriptions.service.js';
import { prisma } from '../lib/prisma.js';
import {
  socketsByUser,
  wsBySocketId,
  symbolsBySocket,
  registerSocket,
  unregisterSocket,
  clearRegistry,
} from './registry.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _wss: WebSocketServer | null = null;
const subscribedRedisChannels = new Set<string>();

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
}

export async function stopWsServer(): Promise<void> {
  for (const ws of wsBySocketId.values()) {
    ws.terminate();
  }
  clearRegistry();
  subscribedRedisChannels.clear();

  if (_wss) {
    await new Promise<void>((r, e) =>
      _wss!.close((err) => (err ? e(err) : r())),
    );
    _wss = null;
  }

  try {
    await redisSubscriber.unsubscribe();
    redisSubscriber.disconnect();
  } catch {
    // ignore cleanup errors
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

  ws.on('message', (data: RawData) => {
    void handleMessage(socketId, ws, data);
  });

  ws.on('close', () => {
    void handleClose(socketId, userId);
  });

  ws.on('error', (err: Error) => {
    console.error('[ws] socket error', err.message);
  });
}

// ---------------------------------------------------------------------------
// Subscribe message handler
// ---------------------------------------------------------------------------

async function handleMessage(
  socketId: string,
  ws: WebSocket,
  data: RawData,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    sendError(ws, 'INVALID_SUBSCRIBE_MESSAGE', 'Message is not valid JSON');
    return;
  }

  if (msg['type'] !== 'subscribe') {
    sendError(
      ws,
      'INVALID_SUBSCRIBE_MESSAGE',
      `Unknown message type: ${String(msg['type'])}`,
    );
    return;
  }

  const payload = msg['payload'] as { symbols?: unknown } | undefined;
  if (!payload || !Array.isArray(payload.symbols)) {
    sendError(ws, 'INVALID_SUBSCRIBE_MESSAGE', 'payload.symbols must be an array of strings');
    return;
  }

  const rawSymbols = payload.symbols as unknown[];
  const stringSymbols = rawSymbols.filter((s): s is string => typeof s === 'string');

  if (stringSymbols.length === 0) {
    sendError(ws, 'INVALID_SUBSCRIBE_MESSAGE', 'payload.symbols must contain at least one string');
    return;
  }

  // Validate against known tokens in DB
  const tokens = await prisma.token.findMany({
    where: { symbol: { in: stringSymbols } },
    select: { symbol: true },
  });
  const validSymbolSet = new Set(tokens.map((t) => t.symbol));

  const invalid = stringSymbols.filter((s) => !validSymbolSet.has(s));
  if (invalid.length > 0) {
    sendError(ws, 'UNKNOWN_SYMBOL', `Unknown symbols: ${invalid.join(', ')}`, { invalid });
    // Do not return — continue subscribing to valid symbols
  }

  const socketSymbols = symbolsBySocket.get(socketId);
  if (!socketSymbols) return; // socket closed before processing

  for (const symbol of stringSymbols) {
    if (!validSymbolSet.has(symbol) || socketSymbols.has(symbol)) continue;

    socketSymbols.add(symbol);

    // Redis SET tracks which sockets want fan-out for this symbol.
    // SADD returns 1 if the member was new; combined with SCARD we detect
    // when this is the first subscriber (subs:SYMBOL was empty before).
    const addedCount = await redis.sadd('subs:' + symbol, socketId);
    if (addedCount === 1) {
      const total = await redis.scard('subs:' + symbol);
      if (total === 1) {
        // First subscriber: open Coinbase feed and Redis sub channel
        await coinbase.subscribeToSymbol(symbol);
        await ensureRedisChannelSubscribed(symbol);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Close handler
// ---------------------------------------------------------------------------

async function handleClose(socketId: string, userId: number): Promise<void> {
  const socketSymbols = symbolsBySocket.get(socketId) ?? new Set<string>();

  for (const symbol of socketSymbols) {
    await redis.srem('subs:' + symbol, socketId);
    const remaining = await redis.scard('subs:' + symbol);
    if (remaining === 0) {
      await coinbase.unsubscribeFromSymbol(symbol);
      await ensureRedisChannelUnsubscribed(symbol);
    }
  }

  unregisterSocket(socketId, userId);
}

// ---------------------------------------------------------------------------
// Redis pub/sub
// ---------------------------------------------------------------------------

async function startRedisSubscriptions(): Promise<void> {
  await redisSubscriber.subscribe('user_events', 'client_events');

  redisSubscriber.on('message', async (channel: string, raw: string) => {
    try {
      if (channel === 'user_events') {
        await handleUserEvent(raw);
      } else if (channel === 'client_events') {
        await handleClientEvent(raw);
      } else if (channel.startsWith('price:')) {
        const symbol = channel.slice('price:'.length);
        await handlePriceUpdate(symbol, raw);
      }
    } catch (e) {
      console.error('[ws] pub/sub handler error', e instanceof Error ? e.message : e);
    }
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

async function handlePriceUpdate(symbol: string, raw: string): Promise<void> {
  let priceData: { price: number; change24h: number };
  try {
    priceData = JSON.parse(raw) as { price: number; change24h: number };
  } catch {
    return;
  }

  const socketIds = await redis.smembers('subs:' + symbol);

  const msg = JSON.stringify({
    type: 'price_update',
    payload: {
      symbol,
      price: priceData.price,
      change24h: priceData.change24h,
    },
    timestamp: new Date().toISOString(),
  });

  for (const sid of socketIds) {
    const ws = wsBySocketId.get(sid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis channel management
// ---------------------------------------------------------------------------

async function ensureRedisChannelSubscribed(symbol: string): Promise<void> {
  if (subscribedRedisChannels.has(symbol)) return;
  await redisSubscriber.subscribe('price:' + symbol);
  subscribedRedisChannels.add(symbol);
}

async function ensureRedisChannelUnsubscribed(symbol: string): Promise<void> {
  if (!subscribedRedisChannels.has(symbol)) return;
  await redisSubscriber.unsubscribe('price:' + symbol);
  subscribedRedisChannels.delete(symbol);
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

function sendError(
  ws: WebSocket,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  ws.send(
    JSON.stringify({
      type: 'error',
      payload: { code, message, ...extra },
      timestamp: new Date().toISOString(),
    }),
  );
}
