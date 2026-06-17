// Neonfi backend — WebSocket server integration tests (Stage 10B; retrofit-28 broadcast).
//
// Strategy: real WS server on an ephemeral HTTP server; real Redis for pub/sub.
// getEffectivePlan is mocked (defaults to 'pro'; tests that need 'free' override it
// per-call). DB is real for user/session creation (register + login + ws-token flow).
//
// retrofit-28: the server is now a BROADCAST FIREHOSE — it psubscribes `price:*`, buffers
// the latest tick per symbol, and flushes ONE batched `price_update` frame to every open
// socket every ~1s. There is no `subscribe` message, no per-symbol fan-out, no `subs:*`
// sets. Tests assert: ticket auth + Pro gate (unchanged), the batched broadcast frame
// reaches sockets that never subscribed, inbound frames are ignored, and the
// plan_downgraded / reconnect control events still fire.

import { it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { startWsServer, stopWsServer } from '../src/ws/server.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted so factories can reference them
// ---------------------------------------------------------------------------

// retrofit-28: the server no longer imports coinbase. The mock stays only as a safety net
// so no transitive import can open a real Coinbase WS during the test run.
vi.mock('../src/lib/coinbase.js', () => ({
  coinbase: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn(),
  },
  CoinbaseClient: vi.fn(),
}));

const { mockGetEffectivePlan } = vi.hoisted(() => ({
  mockGetEffectivePlan: vi.fn<[number], Promise<'free' | 'pro'>>(),
}));

// Partial mock: keep all exports except getEffectivePlan so SubscriptionError etc. still work
vi.mock('../src/modules/subscriptions/subscriptions.service.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/modules/subscriptions/subscriptions.service.js')>();
  return { ...actual, getEffectivePlan: mockGetEffectivePlan };
});

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendUpgradeEmail: vi.fn().mockResolvedValue(undefined),
  sendDowngradeScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendCancellationScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendRefundConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendPlanDowngradeAppliedEmail: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let testServer: HttpServer;
let testUrl: string;

const TEST_EMAIL = 'ws.integration@neonfi.test';
const TEST_EMAIL2 = 'ws.integration2@neonfi.test';
const TEST_PASSWORD = 'Test1234!';
const BASE = '/api/v1';

beforeAll(async () => {
  testServer = createServer();
  await startWsServer(testServer);
  await new Promise<void>((r) => testServer.listen(0, '127.0.0.1', () => r()));
  const { port } = testServer.address() as AddressInfo;
  testUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await stopWsServer();
  await new Promise<void>((r) => testServer.close(() => r()));
});

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
  mockGetEffectivePlan.mockResolvedValue('pro');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register → login → GET /auth/ws-token; returns the one-time ticket string. */
async function getTicket(email = TEST_EMAIL): Promise<string> {
  await app.request(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD, fullName: 'WS Test' }),
  });
  const loginRes = await app.request(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  const cookie = `session=${cookieValue(loginRes, 'session')!}`;
  const tokenRes = await app.request(`${BASE}/auth/ws-token`, {
    headers: { Cookie: cookie },
  });
  return ((await tokenRes.json()) as { data: { token: string } }).data.token;
}

/** Open a WebSocket; resolves when the connection is established. */
function openWs(ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${testUrl}?token=${encodeURIComponent(ticket)}`);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`Unexpected HTTP ${res.statusCode ?? 0}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS open timeout')), 3000);
  });
}

interface Frame {
  type?: string;
  payload?: Record<string, unknown>;
  timestamp?: unknown;
  [k: string]: unknown;
}

/**
 * Wait for the next frame of a given `type`, ignoring others. The firehose can deliver a
 * stray `price_update` at any time (the flush loop is shared module state across the
 * file), so control-event assertions filter for the type they expect.
 */
function nextMessageOfType(ws: WebSocket, type: string, timeout = 4000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for "${type}" frame`));
    }, timeout);
    const onMsg = (data: WebSocket.RawData) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        return;
      }
      if (frame.type !== type) return;
      clearTimeout(t);
      ws.off('message', onMsg);
      resolve(frame);
    };
    ws.on('message', onMsg);
  });
}

/** Collect every frame received over `ms` (used to prove a quiet socket / batching). */
function collectMessages(ws: WebSocket, ms: number): Promise<Frame[]> {
  return new Promise((resolve) => {
    const frames: Frame[] = [];
    const onMsg = (data: WebSocket.RawData) => {
      try {
        frames.push(JSON.parse(data.toString()) as Frame);
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve(frames);
    }, ms);
  });
}

/** Wait for the socket close event; resolves with { code, reason }. */
function waitClose(ws: WebSocket, timeout = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('close timeout')), timeout);
    ws.once('close', (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason.toString() });
    });
  });
}

// ---------------------------------------------------------------------------
// 251. Valid Pro ticket → connection opens
// ---------------------------------------------------------------------------

it('251: valid pro ticket → connection opens (101 upgrade)', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
  await waitClose(ws).catch(() => {});
});

// ---------------------------------------------------------------------------
// 252. Missing token query param → 401
// ---------------------------------------------------------------------------

it('252: missing token query param → HTTP 401 at upgrade', async () => {
  const err = await new Promise<Error>((_, reject) => {
    const ws = new WebSocket(testUrl); // no ?token=
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('open', () => reject(new Error('should not open')));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  }).catch((e: unknown) => e as Error & { statusCode?: number });
  expect((err as { statusCode?: number }).statusCode).toBe(401);
});

// ---------------------------------------------------------------------------
// 253. Invalid ticket (random string) → 401
// ---------------------------------------------------------------------------

it('253: invalid ticket (random string) → 401', async () => {
  const err = await new Promise<Error>((_, reject) => {
    const ws = new WebSocket(`${testUrl}?token=totally_not_a_real_ticket_xyz123`);
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('open', () => reject(new Error('should not open')));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  }).catch((e: unknown) => e as Error & { statusCode?: number });
  expect((err as { statusCode?: number }).statusCode).toBe(401);
});

// ---------------------------------------------------------------------------
// 254. Expired ticket → 401
// ---------------------------------------------------------------------------

it('254: expired ticket (TTL elapsed) → 401', async () => {
  const token = 'expired_ticket_' + Math.random().toString(36).slice(2);
  await redis.set('ws_ticket:' + token, '1:1', 'PX', 1); // 1 ms — expires immediately
  await new Promise((r) => setTimeout(r, 50)); // ensure expiry

  const err = await new Promise<Error>((_, reject) => {
    const ws = new WebSocket(`${testUrl}?token=${token}`);
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('open', () => reject(new Error('should not open')));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  }).catch((e: unknown) => e as Error & { statusCode?: number });
  expect((err as { statusCode?: number }).statusCode).toBe(401);
});

// ---------------------------------------------------------------------------
// 255. Consumed ticket (used once already) → 401
// ---------------------------------------------------------------------------

it('255: consumed ticket (used once already) → 401 on second use', async () => {
  const ticket = await getTicket();
  // First use — should succeed
  const ws1 = await openWs(ticket);
  ws1.close();
  await waitClose(ws1).catch(() => {});

  // Second use — ticket consumed by GETDEL → 401
  const err = await new Promise<Error>((_, reject) => {
    const ws = new WebSocket(`${testUrl}?token=${ticket}`);
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('open', () => reject(new Error('should not open')));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  }).catch((e: unknown) => e as Error & { statusCode?: number });
  expect((err as { statusCode?: number }).statusCode).toBe(401);
});

// ---------------------------------------------------------------------------
// 256. Free user ticket → 403
// ---------------------------------------------------------------------------

it('256: free user ticket → 403 (free users rejected at handshake)', async () => {
  mockGetEffectivePlan.mockResolvedValue('free');
  const ticket = await getTicket();

  const err = await new Promise<Error>((_, reject) => {
    const ws = new WebSocket(`${testUrl}?token=${ticket}`);
    ws.once('unexpected-response', (_req, res) => {
      const e = new Error(`HTTP ${res.statusCode}`) as Error & { statusCode: number };
      e.statusCode = res.statusCode ?? 0;
      ws.terminate();
      reject(e);
    });
    ws.once('open', () => reject(new Error('should not open')));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  }).catch((e: unknown) => e as Error & { statusCode?: number });
  expect((err as { statusCode?: number }).statusCode).toBe(403);
});

// ---------------------------------------------------------------------------
// 257. Broadcast firehose: a price publish reaches EVERY open socket (no subscribe)
// ---------------------------------------------------------------------------

it('257: publish price:BTC → every open socket receives the batched price_update frame (no subscribe)', async () => {
  const ticket1 = await getTicket(TEST_EMAIL);
  const ticket2 = await getTicket(TEST_EMAIL2);

  const ws1 = await openWs(ticket1);
  const ws2 = await openWs(ticket2);

  // Neither socket sent ANY subscribe frame — the firehose delivers everything.
  const msg1Promise = nextMessageOfType(ws1, 'price_update');
  const msg2Promise = nextMessageOfType(ws2, 'price_update');

  await redis.publish('price:BTC', JSON.stringify({ price: 50000, change24h: 1.5, timestamp: Date.now() }));

  const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

  for (const msg of [msg1, msg2]) {
    expect(msg.type).toBe('price_update');
    const payload = msg.payload as { prices?: Array<{ symbol: string; price: number; change24h: number }> };
    expect(Array.isArray(payload.prices)).toBe(true);
    const btc = payload.prices!.find((p) => p.symbol === 'BTC')!;
    expect(btc).toEqual({ symbol: 'BTC', price: 50000, change24h: 1.5 });
    expect(typeof msg.timestamp).toBe('string');
    // Prices are nested under payload.prices[] — NOT flat on the frame or the payload.
    expect((msg as Record<string, unknown>)['symbol']).toBeUndefined();
    expect((msg.payload as Record<string, unknown>)['symbol']).toBeUndefined();
  }

  ws1.close();
  ws2.close();
  await new Promise((r) => setTimeout(r, 200));
});

// ---------------------------------------------------------------------------
// 258. Batching: multiple symbols published in a window arrive in the prices[] array
// ---------------------------------------------------------------------------

it('258: multiple symbols → delivered batched under one payload.prices[] (latest wins per symbol)', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  const framesPromise = collectMessages(ws, 1600); // ~1.5 flush windows
  // Two distinct symbols + a second BTC tick (latest must win for BTC).
  await redis.publish('price:BTC', JSON.stringify({ price: 50000, change24h: 1.5 }));
  await redis.publish('price:ETH', JSON.stringify({ price: 3000, change24h: -2.0 }));
  await redis.publish('price:BTC', JSON.stringify({ price: 50500, change24h: 1.7 }));

  const frames = await framesPromise;
  const priceFrames = frames.filter((f) => f.type === 'price_update');
  expect(priceFrames.length).toBeGreaterThan(0);

  // Merge all delivered prices; both symbols must appear, BTC at its latest value.
  const merged = new Map<string, { price: number; change24h: number }>();
  for (const f of priceFrames) {
    const prices = (f.payload as { prices: Array<{ symbol: string; price: number; change24h: number }> }).prices;
    for (const p of prices) merged.set(p.symbol, { price: p.price, change24h: p.change24h });
  }
  expect(merged.get('BTC')).toEqual({ price: 50500, change24h: 1.7 });
  expect(merged.get('ETH')).toEqual({ price: 3000, change24h: -2.0 });

  ws.close();
  await waitClose(ws).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
});

// ---------------------------------------------------------------------------
// 259. Inbound client frames are ignored (no protocol) — connection stays open, no reply
// ---------------------------------------------------------------------------

it('259: inbound frames are ignored (no subscribe protocol) → no reply, socket stays open', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  // Clients send nothing now; whatever they send is dropped — no error envelope back.
  ws.send('not valid JSON {{{{{');
  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));

  const frames = await collectMessages(ws, 400);
  expect(frames).toEqual([]); // no error frame, no echo — nothing came back
  expect(ws.readyState).toBe(WebSocket.OPEN);

  ws.close();
  await waitClose(ws).catch(() => {});
});

// ---------------------------------------------------------------------------
// 265. user_events plan_changed for connected Pro user → plan_downgraded + 4003
// ---------------------------------------------------------------------------

it('265: user_events plan_changed for connected Pro user → plan_downgraded envelope + close 4003', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });

  // After connection, the plan check on the pub/sub event should return 'free'
  mockGetEffectivePlan.mockResolvedValue('free');

  const msgPromise = nextMessageOfType(ws, 'plan_downgraded');
  const closePromise = waitClose(ws);

  await redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: user.id }));

  const [msg, close] = await Promise.all([msgPromise, closePromise]);

  expect(msg.type).toBe('plan_downgraded');
  expect((msg.payload as Record<string, unknown>)['message']).toBe('Your Pro subscription has expired');
  expect(close.code).toBe(4003);
});

// ---------------------------------------------------------------------------
// 266. plan_changed for user not connected → no-op
// ---------------------------------------------------------------------------

it('266: plan_changed event for user not connected → no-op (no error thrown)', async () => {
  await expect(
    redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: 999999 })),
  ).resolves.not.toThrow();
  await new Promise((r) => setTimeout(r, 300));
  // Test passes if no unhandled errors are thrown
});

// ---------------------------------------------------------------------------
// 267. client_events reconnect → all connected sockets receive reconnect envelope
// ---------------------------------------------------------------------------

it('267: client_events reconnect → all connected sockets receive reconnect envelope', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  const msgPromise = nextMessageOfType(ws, 'reconnect');

  await redis.publish(
    'client_events',
    JSON.stringify({ type: 'reconnect', payload: { retryAfterMs: 1000, reason: 'coinbase_reconnecting' } }),
  );

  const msg = await msgPromise;

  expect(msg.type).toBe('reconnect');
  expect(msg.payload).toMatchObject({ retryAfterMs: 1000, reason: 'coinbase_reconnecting' });
  expect(typeof msg.timestamp).toBe('string');

  ws.close();
  await waitClose(ws).catch(() => {});
});
