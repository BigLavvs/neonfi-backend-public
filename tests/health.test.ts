// Neonfi backend — /health and /ws/health endpoint tests (Stage 10A).
//
// Strategy: mock coinbase, prisma, and redis so these tests are deterministic
// regardless of Neon cold-start latency or real Redis availability.

import { it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/app.js';

// ---------------------------------------------------------------------------
// Hoist mocks so factories can reference them
// ---------------------------------------------------------------------------

const { mockIsConnected, mockPrismaQuery, mockRedisPing } = vi.hoisted(() => ({
  mockIsConnected: vi.fn<[], boolean>(),
  mockPrismaQuery: vi.fn(),
  mockRedisPing: vi.fn(),
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

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockPrismaQuery.mockResolvedValue([{ 1: 1 }]);
  mockRedisPing.mockResolvedValue('PONG');
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
// 248. GET /health with Coinbase down → 503
// ---------------------------------------------------------------------------

it('248: GET /health with Coinbase down — 503 response with coinbase:down', async () => {
  mockIsConnected.mockReturnValue(false);

  const res = await app.request('/health');
  expect(res.status).toBe(503);
  const body = await res.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('HEALTH_FAILED');
  expect(body.error.message).toContain('coinbase');
});

// ---------------------------------------------------------------------------
// 249. GET /ws/health with Coinbase up → 200 { coinbase:'up', clientWs:'up' }
// ---------------------------------------------------------------------------

it('249: GET /ws/health with Coinbase up — 200 { coinbase:up, clientWs:up }', async () => {
  mockIsConnected.mockReturnValue(true);

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

  const res = await app.request('/ws/health');
  expect(res.status).toBe(503);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('WS_HEALTH_FAILED');
});
