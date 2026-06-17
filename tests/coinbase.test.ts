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
// Mock the resolver — the Advanced Trade ticker parser (retrofit-30) hands each
// tick to recordTick(); the parse tests assert ITS args (base/price/change/quote)
// rather than reaching through to Redis. recordTick returns a promise (the client
// `.catch`-es it), so the mock must resolve.
// ---------------------------------------------------------------------------

const { mockRecordTick } = vi.hoisted(() => ({ mockRecordTick: vi.fn(() => Promise.resolve()) }));

vi.mock('../src/lib/price-resolver.js', () => ({
  recordTick: mockRecordTick,
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

// ---------------------------------------------------------------------------
// 239. Advanced Trade ticker parse (retrofit-30) → recordTick per nested ticker
// ---------------------------------------------------------------------------

it('239: channel:ticker frame (events[].tickers[]) → recordTick per ticker with right base/price/change', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  // Captured Advanced Trade shape: routing key is `channel` (not `type`); tickers are
  // nested under events[].tickers[]; the 24h change field is `price_percent_chg_24_h`.
  const frame = JSON.stringify({
    channel: 'ticker',
    timestamp: '2026-06-17T00:00:00Z',
    sequence_num: 0,
    events: [
      {
        type: 'snapshot',
        tickers: [
          { type: 'ticker', product_id: 'BTC-USD', price: '64899.54', price_percent_chg_24_h: '-2.3265998' },
          { type: 'ticker', product_id: 'ETH-USD', price: '3201.10', price_percent_chg_24_h: '1.5' },
        ],
      },
    ],
  });

  client.handleMessage(frame);

  expect(mockRecordTick).toHaveBeenCalledTimes(2);
  expect(mockRecordTick).toHaveBeenNthCalledWith(1, 'BTC', 'coinbase', 64899.54, -2.3265998, 'USD');
  expect(mockRecordTick).toHaveBeenNthCalledWith(2, 'ETH', 'coinbase', 3201.1, 1.5, 'USD');
});

// ---------------------------------------------------------------------------
// 240. The 24h change comes from price_percent_chg_24_h, NOT the legacy field
// ---------------------------------------------------------------------------

it('240: reads price_percent_chg_24_h (Advanced Trade), not the legacy price_percent_chg_24h', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  client.handleMessage(JSON.stringify({
    channel: 'ticker',
    events: [
      {
        type: 'update',
        tickers: [
          {
            product_id: 'SOL-USD',
            price: '150.00',
            price_percent_chg_24h: '99.9', // legacy (wrong) — must be ignored
            price_percent_chg_24_h: '3.25', // Advanced Trade (correct) — must win
          },
        ],
      },
    ],
  }));

  expect(mockRecordTick).toHaveBeenCalledTimes(1);
  // change24h is 3.25 (the underscored field), never 99.9 — locks the field-name regression out.
  expect(mockRecordTick).toHaveBeenCalledWith('SOL', 'coinbase', 150, 3.25, 'USD');
});

// ---------------------------------------------------------------------------
// 241. channel:subscriptions ack → no recordTick
// ---------------------------------------------------------------------------

it('241: channel:subscriptions ack → no recordTick', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  client.handleMessage(JSON.stringify({
    channel: 'subscriptions',
    events: [{ subscriptions: { ticker: ['BTC-USD', 'ETH-USD'] } }],
  }));

  expect(mockRecordTick).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 242. Malformed / non-ticker / incomplete frames → no throw, no recordTick
// ---------------------------------------------------------------------------

it('242: malformed, non-ticker, and incomplete-ticker frames → no throw, no recordTick', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  expect(() => client.handleMessage('not json {{{{{')).not.toThrow();
  expect(() => client.handleMessage(JSON.stringify({ channel: 'heartbeats' }))).not.toThrow();
  // ticker channel but no events / empty tickers
  expect(() => client.handleMessage(JSON.stringify({ channel: 'ticker' }))).not.toThrow();
  expect(() => client.handleMessage(JSON.stringify({ channel: 'ticker', events: [{ tickers: [] }] }))).not.toThrow();
  // tickers present but each unusable (no product_id / non-numeric price) → skipped
  expect(() =>
    client.handleMessage(JSON.stringify({
      channel: 'ticker',
      events: [{ tickers: [{ price: '100' }, { product_id: 'BTC-USD', price: 'abc' }] }],
    })),
  ).not.toThrow();

  expect(mockRecordTick).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 243. Subscribe frame uses singular channel:"ticker" (Advanced Trade), not channels[]
// ---------------------------------------------------------------------------

it('243: subscribe frame uses singular channel:"ticker", not the legacy channels[] array', async () => {
  const client = new CoinbaseClient(serverUrl);

  const serverConn = new Promise<WsServer>((r) => wss.once('connection', (ws) => r(ws)));
  client.connect();
  const serverSocket = await serverConn;
  await sleep(50);

  const msgPromise = new Promise<string>((r) => serverSocket.once('message', (d) => r(d.toString())));
  await client.subscribeToSymbol('BTC');
  const msg = JSON.parse(await msgPromise) as Record<string, unknown>;

  expect(msg['type']).toBe('subscribe');
  expect(msg['channel']).toBe('ticker'); // singular field present
  expect(msg['channels']).toBeUndefined(); // legacy array field gone — regression guard
  expect(msg['product_ids']).toContain('BTC-USD');

  client.disconnect();
});

// ---------------------------------------------------------------------------
// 244. channel:subscriptions ack → logs confirmed product count (retrofit-31)
// ---------------------------------------------------------------------------

it('244: channel:subscriptions ack → logs confirmed product count; no recordTick', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => { logs.push(String(msg)); };

  expect(() =>
    client.handleMessage(JSON.stringify({
      channel: 'subscriptions',
      events: [{ subscriptions: { ticker: ['BTC-USD', 'ETH-USD', 'SOL-USD'] } }],
    })),
  ).not.toThrow();

  console.log = origLog;

  expect(mockRecordTick).not.toHaveBeenCalled();
  const ack = logs.find((l) => l.includes('coinbase_subscriptions_ack'));
  expect(ack).toBeDefined();
  expect((JSON.parse(ack as string) as { confirmed: number }).confirmed).toBe(3);
});

// ---------------------------------------------------------------------------
// 245. Error frame (no channel, type:error/message) → coinbase_ws_error (retrofit-31)
// ---------------------------------------------------------------------------

it('245: error frame (no channel, type:error) → logs coinbase_ws_error; no throw; no recordTick', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  const errs: string[] = [];
  const origErr = console.error;
  console.error = (msg: string) => { errs.push(String(msg)); };

  expect(() =>
    client.handleMessage(JSON.stringify({
      type: 'error',
      message: 'invalid product_ids in subscribe',
    })),
  ).not.toThrow();

  console.error = origErr;

  expect(mockRecordTick).not.toHaveBeenCalled();
  const errLine = errs.find((l) => l.includes('coinbase_ws_error'));
  expect(errLine).toBeDefined();
  expect((JSON.parse(errLine as string) as { detail: string }).detail).toContain('invalid product_ids');
});

// ---------------------------------------------------------------------------
// 246. coinbase_first_tick beacon fires at most once across two ticker frames (retrofit-31)
// ---------------------------------------------------------------------------

it('246: coinbase_first_tick beacon fires at most once across two ticker frames', () => {
  mockRecordTick.mockClear();
  const client = new CoinbaseClient(serverUrl);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => { logs.push(String(msg)); };

  // Module-level `loggedFirstTick` may already be set by an earlier ticker test,
  // so the beacon fires 0× (already logged) or 1× (first ever) — never twice.
  const frame = JSON.stringify({
    channel: 'ticker',
    events: [{ tickers: [{ product_id: 'ADA-USD', price: '0.45', price_percent_chg_24_h: '1.0' }] }],
  });
  expect(() => client.handleMessage(frame)).not.toThrow();
  expect(() => client.handleMessage(frame)).not.toThrow();

  console.log = origLog;

  expect(mockRecordTick).toHaveBeenCalledTimes(2);
  const firstTickLogs = logs.filter((l) => l.includes('coinbase_first_tick'));
  expect(firstTickLogs.length).toBeLessThanOrEqual(1);
});
