// Neonfi backend — Coinbase WS client tests (Stage 10A).
//
// Strategy: spin up a tiny ws.Server on an ephemeral port; instantiate a fresh
// CoinbaseClient(url) pointing at it. Tests control the server-side to simulate
// connects, messages, and drops. The module-level singleton is NOT used.

import { it, beforeAll, afterAll, expect, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { CoinbaseClient } from '../src/lib/coinbase.js';

// ---------------------------------------------------------------------------
// Mock redis — price writes in ticker handler must not hit real Redis
// ---------------------------------------------------------------------------

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    set: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Shared WS server
// ---------------------------------------------------------------------------

let wss: WebSocketServer;
let serverUrl: string;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', r));
  const addr = wss.address() as AddressInfo;
  serverUrl = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r, e) => wss.close((err) => (err ? e(err) : r())));
});

// ---------------------------------------------------------------------------
// 233. Connect successfully → state transitions; log emitted
// ---------------------------------------------------------------------------

it('233: connect successfully — state transitions disconnected→connecting→connected; log emitted', async () => {
  const client = new CoinbaseClient(serverUrl);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => { logs.push(msg); origLog(msg); };

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));

  client.connect();
  expect(client.isConnected()).toBe(false); // still connecting

  await serverConn;
  await sleep(50); // allow 'open' handler to fire

  expect(client.isConnected()).toBe(true);
  expect(logs.some((l) => l.includes('coinbase_connected'))).toBe(true);

  console.log = origLog;
  client.disconnect();
});

// ---------------------------------------------------------------------------
// 234. First subscribe → server receives subscribe message; refcount = 1
// ---------------------------------------------------------------------------

it('234: first subscribe to symbol — Coinbase subscribe message sent; refcount=1', async () => {
  const client = new CoinbaseClient(serverUrl);

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const serverSocket = await serverConn;
  await sleep(50);

  const msgPromise = new Promise<string>((r) => serverSocket.once('message', (d) => r(d.toString())));
  await client.subscribeToSymbol('BTC');
  const raw = await msgPromise;
  const msg = JSON.parse(raw) as { type: string; product_ids: string[] };

  expect(msg.type).toBe('subscribe');
  expect(msg.product_ids).toContain('BTC-USD');

  client.disconnect();
});

// ---------------------------------------------------------------------------
// 235. Second subscribe to same symbol → no second send (refcount = 2)
// ---------------------------------------------------------------------------

it('235: second subscribe to same symbol — no duplicate Coinbase message; refcount=2', async () => {
  const client = new CoinbaseClient(serverUrl);

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const serverSocket = await serverConn;
  await sleep(50);

  const messages: string[] = [];
  serverSocket.on('message', (d) => messages.push(d.toString()));

  await client.subscribeToSymbol('ETH');
  await sleep(30);
  const countAfterFirst = messages.length;

  await client.subscribeToSymbol('ETH');
  await sleep(30);

  expect(messages.length).toBe(countAfterFirst); // no second subscribe sent

  client.disconnect();
});

// ---------------------------------------------------------------------------
// 236. First unsubscribe (refcount 2 → 1) → no unsubscribe message sent
// ---------------------------------------------------------------------------

it('236: unsubscribe with refcount 2→1 — no Coinbase unsubscribe message sent', async () => {
  const client = new CoinbaseClient(serverUrl);

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const serverSocket = await serverConn;
  await sleep(50);

  await client.subscribeToSymbol('SOL');
  await client.subscribeToSymbol('SOL'); // refcount = 2

  const unsubMessages: string[] = [];
  serverSocket.on('message', (d) => {
    const parsed = JSON.parse(d.toString()) as { type: string };
    if (parsed.type === 'unsubscribe') unsubMessages.push(d.toString());
  });

  await client.unsubscribeFromSymbol('SOL'); // refcount → 1
  await sleep(30);
  expect(unsubMessages.length).toBe(0);

  client.disconnect();
});

// ---------------------------------------------------------------------------
// 237. Last unsubscribe (refcount 1 → 0) → unsubscribe message sent
// ---------------------------------------------------------------------------

it('237: last unsubscribe (refcount 1→0) — Coinbase unsubscribe message sent', async () => {
  const client = new CoinbaseClient(serverUrl);

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const serverSocket = await serverConn;
  await sleep(50);

  await client.subscribeToSymbol('MATIC');
  await sleep(30);

  const unsubPromise = new Promise<string>((r) =>
    serverSocket.once('message', (d) => r(d.toString())),
  );

  await client.unsubscribeFromSymbol('MATIC'); // refcount → 0
  const raw = await unsubPromise;
  const msg = JSON.parse(raw) as { type: string; product_ids: string[] };

  expect(msg.type).toBe('unsubscribe');
  expect(msg.product_ids).toContain('MATIC-USD');

  client.disconnect();
});

// ---------------------------------------------------------------------------
// 238. Connection drop → reconnect with 1s backoff
// ---------------------------------------------------------------------------

it('238: connection drop — client transitions to reconnecting; reconnects after ~1s backoff', async () => {
  const client = new CoinbaseClient(serverUrl);

  // Track the first connection
  const firstConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const firstSocket = await firstConn;
  await sleep(50);
  expect(client.isConnected()).toBe(true);

  // Server-side kill
  const secondConn = new Promise<void>((r) => wss.once('connection', () => r()));
  firstSocket.terminate();

  // Client should be reconnecting shortly
  await sleep(100);
  expect(client.isConnected()).toBe(false);

  // Should reconnect within ~1.5s (first backoff = 1000ms + overhead)
  await secondConn;
  await sleep(100);
  expect(client.isConnected()).toBe(true);

  client.disconnect();
}, 5000);
