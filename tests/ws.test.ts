// Neonfi backend — WebSocket server integration tests (Stage 10B).
//
// Strategy: real WS server on an ephemeral HTTP server; real Redis for pub/sub.
// Coinbase is mocked (no real Coinbase calls). getEffectivePlan is mocked
// (defaults to 'pro'; tests that need 'free' override it per-call).
// DB is real for user/session creation (register + login + ws-token flow).

import { it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';
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

const { mockSubscribeToSymbol, mockUnsubscribeFromSymbol } = vi.hoisted(() => ({
  mockSubscribeToSymbol: vi.fn<[string], Promise<void>>(),
  mockUnsubscribeFromSymbol: vi.fn<[string], Promise<void>>(),
}));

vi.mock('../src/lib/coinbase.js', () => ({
  coinbase: {
    isConnected: vi.fn().mockReturnValue(true),
    subscribeToSymbol: mockSubscribeToSymbol,
    unsubscribeFromSymbol: mockUnsubscribeFromSymbol,
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
  const subsKeys = await redis.keys('subs:*');
  if (subsKeys.length) await redis.del(subsKeys);
  mockSubscribeToSymbol.mockClear().mockResolvedValue(undefined);
  mockUnsubscribeFromSymbol.mockClear().mockResolvedValue(undefined);
  mockGetEffectivePlan.mockResolvedValue('pro');
});

afterEach(async () => {
  // No-op: beforeEach already calls truncateAllUserData() for next test's clean state.
  // A second TRUNCATE here caused PostgreSQL deadlocks under Neon's serverless pooler.
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

/** Wait for the next message frame on a socket. */
function nextMessage(ws: WebSocket, timeout = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
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

/** Poll until a vi.fn() has been called at least once. */
async function waitForCall(
  mock: ReturnType<typeof vi.fn>,
  timeout = 8000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (mock.mock.calls.length === 0) {
    if (Date.now() >= deadline) throw new Error('mock was never called within timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Poll until a Redis SET has at least minCount members. */
async function waitForRedisSet(
  key: string,
  minCount = 1,
  timeout = 8000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    const count = await redis.scard(key);
    if (count >= minCount) return;
    if (Date.now() >= deadline) throw new Error(`${key} never reached ${minCount} members`);
    await new Promise((r) => setTimeout(r, 100));
  }
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
// 257. Subscribe to BTC → coinbase.subscribeToSymbol called once
// ---------------------------------------------------------------------------

it('257: subscribe to BTC → coinbase.subscribeToSymbol called once for BTC', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForCall(mockSubscribeToSymbol);

  expect(mockSubscribeToSymbol).toHaveBeenCalledOnce();
  expect(mockSubscribeToSymbol).toHaveBeenCalledWith('BTC');

  ws.close();
  await waitClose(ws).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
});

// ---------------------------------------------------------------------------
// 258. Second socket subscribes to same BTC → subscribeToSymbol NOT called again
// ---------------------------------------------------------------------------

it('258: second socket subscribes to BTC → subscribeToSymbol NOT called again (refcount)', async () => {
  const ticket1 = await getTicket(TEST_EMAIL);
  const ticket2 = await getTicket(TEST_EMAIL2);

  const ws1 = await openWs(ticket1);
  const ws2 = await openWs(ticket2);

  ws1.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForCall(mockSubscribeToSymbol);

  ws2.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForRedisSet('subs:BTC', 2);

  expect(mockSubscribeToSymbol).toHaveBeenCalledOnce();
  expect(mockSubscribeToSymbol).toHaveBeenCalledWith('BTC');

  ws1.close();
  ws2.close();
  await new Promise((r) => setTimeout(r, 300));
});

// ---------------------------------------------------------------------------
// 259. Publish price:BTC → both subscribers receive price_update envelope
// ---------------------------------------------------------------------------

it('259: publish price:BTC → both subscribers receive price_update envelope with exact shape', async () => {
  const ticket1 = await getTicket(TEST_EMAIL);
  const ticket2 = await getTicket(TEST_EMAIL2);

  const ws1 = await openWs(ticket1);
  const ws2 = await openWs(ticket2);

  ws1.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  ws2.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForRedisSet('subs:BTC', 2);

  const msg1Promise = nextMessage(ws1);
  const msg2Promise = nextMessage(ws2);

  await redis.publish('price:BTC', JSON.stringify({ price: 50000, change24h: 1.5, timestamp: Date.now() }));

  const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

  for (const msg of [msg1, msg2]) {
    expect(msg).toMatchObject({
      type: 'price_update',
      payload: { symbol: 'BTC', price: 50000, change24h: 1.5 },
    });
    expect(typeof msg['timestamp']).toBe('string');
    // Verify payload is nested, not flat (frontend reads msg.payload.symbol)
    expect(msg['symbol']).toBeUndefined();
  }

  ws1.close();
  ws2.close();
  await new Promise((r) => setTimeout(r, 200));
});

// ---------------------------------------------------------------------------
// 260. Publish price:ETH (no subscribers) → no socket receives anything
// ---------------------------------------------------------------------------

it('260: publish price:ETH (no subscribers) → no socket receives anything', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  // Subscribe to BTC only, not ETH
  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await new Promise((r) => setTimeout(r, 200));

  let received = false;
  ws.once('message', () => { received = true; });

  await redis.publish('price:ETH', JSON.stringify({ price: 3000, change24h: 0.5, timestamp: Date.now() }));
  await new Promise((r) => setTimeout(r, 300));

  expect(received).toBe(false);

  ws.close();
  await waitClose(ws).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
});

// ---------------------------------------------------------------------------
// 261. Disconnect socket → subs:BTC Redis SET no longer contains its socketId
// ---------------------------------------------------------------------------

it('261: disconnect socket → subs:BTC Redis SET no longer contains its socketId', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForRedisSet('subs:BTC', 1);

  const membersBefore = await redis.smembers('subs:BTC');
  expect(membersBefore.length).toBeGreaterThan(0);

  const closePromise = waitClose(ws);
  ws.close();
  await closePromise.catch(() => {});
  await new Promise((r) => setTimeout(r, 300));

  const membersAfter = await redis.smembers('subs:BTC');
  expect(membersAfter.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 262. Last subscriber disconnects → coinbase.unsubscribeFromSymbol called
// ---------------------------------------------------------------------------

it('262: last subscriber disconnects → coinbase.unsubscribeFromSymbol called for BTC', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['BTC'] } }));
  await waitForCall(mockSubscribeToSymbol);

  const closePromise = waitClose(ws);
  ws.close();
  await closePromise.catch(() => {});
  await waitForCall(mockUnsubscribeFromSymbol);

  expect(mockUnsubscribeFromSymbol).toHaveBeenCalledOnce();
  expect(mockUnsubscribeFromSymbol).toHaveBeenCalledWith('BTC');
});

// ---------------------------------------------------------------------------
// 263. Malformed subscribe message → error envelope; connection stays open
// ---------------------------------------------------------------------------

it('263: malformed subscribe message (not JSON) → error envelope; connection stays open', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  ws.send('not valid JSON {{{{{');
  const msg = await nextMessage(ws);

  expect(msg['type']).toBe('error');
  expect((msg['payload'] as Record<string, unknown>)['code']).toBe('INVALID_SUBSCRIBE_MESSAGE');
  expect(ws.readyState).toBe(WebSocket.OPEN);

  ws.close();
  await waitClose(ws).catch(() => {});
});

// ---------------------------------------------------------------------------
// 264. Subscribe to unknown symbol → error with payload.invalid; valid still subscribed
// ---------------------------------------------------------------------------

it('264: subscribe to unknown symbol → error envelope with payload.invalid; valid symbols still subscribed', async () => {
  const ticket = await getTicket();
  const ws = await openWs(ticket);

  ws.send(JSON.stringify({ type: 'subscribe', payload: { symbols: ['XYZ_FAKE_TOKEN', 'BTC'] } }));
  const msg = await nextMessage(ws);

  expect(msg['type']).toBe('error');
  const payload = msg['payload'] as { code: string; invalid: string[] };
  expect(payload.code).toBe('UNKNOWN_SYMBOL');
  expect(payload.invalid).toContain('XYZ_FAKE_TOKEN');
  expect(payload.invalid).not.toContain('BTC');

  await waitForCall(mockSubscribeToSymbol);
  expect(mockSubscribeToSymbol).toHaveBeenCalledWith('BTC');

  ws.close();
  await waitClose(ws).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
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

  const msgPromise = nextMessage(ws);
  const closePromise = waitClose(ws);

  await redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: user.id }));

  const [msg, close] = await Promise.all([msgPromise, closePromise]);

  expect(msg['type']).toBe('plan_downgraded');
  expect((msg['payload'] as Record<string, unknown>)['message']).toBe('Your Pro subscription has expired');
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

  const msgPromise = nextMessage(ws);

  await redis.publish(
    'client_events',
    JSON.stringify({ type: 'reconnect', payload: { retryAfterMs: 1000, reason: 'coinbase_reconnecting' } }),
  );

  const msg = await msgPromise;

  expect(msg['type']).toBe('reconnect');
  expect(msg['payload']).toMatchObject({ retryAfterMs: 1000, reason: 'coinbase_reconnecting' });
  expect(typeof msg['timestamp']).toBe('string');

  ws.close();
  await waitClose(ws).catch(() => {});
});
