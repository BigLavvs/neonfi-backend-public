// Neonfi backend — /health and /ws/health endpoint tests (Stage 10A/10B).
//
// Strategy: mock coinbase, prisma, redis, and isWsServerRunning so these
// tests are deterministic regardless of Neon cold-start or real Redis.

import { it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/app.js';

// ---------------------------------------------------------------------------
// Hoist mocks so factories can reference them
// ---------------------------------------------------------------------------

const { mockIsConnected, mockPrismaQuery, mockRedisPing, mockIsWsServerRunning } = vi.hoisted(() => ({
  mockIsConnected: vi.fn<[], boolean>(),
  mockPrismaQuery: vi.fn(),
  mockRedisPing: vi.fn(),
  mockIsWsServerRunning: vi.fn<[], boolean>(),
}));

vi.mock('../src/lib/coinbase.js', () => ({
  coinbase: { isConnected: mockIsConnected },
  CoinbaseClient: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: mockPrismaQuery },
}));

vi.mock('../src/lib/redis.js', () => ({
  redis: { ping: mockRedisPing },
}));

vi.mock('../src/ws/server.js', () => ({
  isWsServerRunning: mockIsWsServerRunning,
  startWsServer: vi.fn().mockResolvedValue(undefined),
  stopWsServer: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockPrismaQuery.mockResolvedValue([{ 1: 1 }]);
  mockRedisPing.mockResolvedValue('PONG');
  mockIsWsServerRunning.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// 247. GET /health with Coinbase up → 200 includes coinbase:'up'
// ---------------------------------------------------------------------------

it('247: GET /health with Coinbase up — 200 response includes coinbase:up', async () => {
  mockIsConnected.mockReturnValue(true);

  const res = await app.request('/health');
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { coinbase: string; db: string; redis: string } };
  expect(body.data.coinbase).toBe('up');
  expect(body.data.db).toBe('up');
  expect(body.data.redis).toBe('up');
});

// ---------------------------------------------------------------------------
// 248. GET /health with Coinbase down but DB/Redis up → 200
// ---------------------------------------------------------------------------

it('248: GET /health with Coinbase down but DB/Redis up — 200 response with coinbase:down', async () => {
  mockIsConnected.mockReturnValue(false);

  const res = await app.request('/health');
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { coinbase: string; db: string; redis: string } };
  expect(body.data.coinbase).toBe('down');
  expect(body.data.db).toBe('up');
  expect(body.data.redis).toBe('up');
});

// ---------------------------------------------------------------------------
// 249. GET /ws/health with Coinbase up + WS server up → 200
// ---------------------------------------------------------------------------

it('249: GET /ws/health with Coinbase up + WS server up — 200 { coinbase:up, clientWs:up }', async () => {
  mockIsConnected.mockReturnValue(true);
  mockIsWsServerRunning.mockReturnValue(true);

  const res = await app.request('/ws/health');
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { status: string; coinbase: string; clientWs: string } };
  expect(body.data.status).toBe('ok');
  expect(body.data.coinbase).toBe('up');
  expect(body.data.clientWs).toBe('up');
});

// ---------------------------------------------------------------------------
// 250. GET /ws/health with Coinbase down → 503
// ---------------------------------------------------------------------------

it('250: GET /ws/health with Coinbase down — 503 WS_HEALTH_FAILED', async () => {
  mockIsConnected.mockReturnValue(false);
  mockIsWsServerRunning.mockReturnValue(true);

  const res = await app.request('/ws/health');
  expect(res.status).toBe(503);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('WS_HEALTH_FAILED');
});

// ---------------------------------------------------------------------------
// 268. GET /ws/health when WS server NOT running → 503 with clientWs: 'down'
// ---------------------------------------------------------------------------

it('268: GET /ws/health when WS server NOT running — 503 with clientWs:down in message', async () => {
  mockIsConnected.mockReturnValue(true);
  mockIsWsServerRunning.mockReturnValue(false);

  const res = await app.request('/ws/health');
  expect(res.status).toBe(503);
  const body = await res.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('WS_HEALTH_FAILED');
  expect(body.error.message).toContain('clientWs');
});
