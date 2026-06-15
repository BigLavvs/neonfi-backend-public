// Neonfi backend — Binance/Kraken WS client tests (retrofit-16).
//
// Two strategies:
//   1. Parse tests — feed a CAPTURED exchange frame straight into the client's
//      public handleMessage(); assert the right `price:<SYM>:<exchange>` keys are
//      written via the in-memory Redis mock. No socket needed.
//   2. Connect tests — spin tiny ws.Servers on ephemeral ports and point fresh
//      clients at them (mirrors coinbase.test.ts). Verifies the Kraken subscribe
//      wire format and the BINANCE_ENABLED=false degraded-mode boot decision.

import { it, expect, describe, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsServer } from 'ws';
import type { AddressInfo } from 'node:net';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    publish: vi.fn(async () => 1),
  },
}));

import { BinanceClient } from '../src/lib/binance.js';
import { KrakenClient } from '../src/lib/kraken.js';
import { CoinbaseClient } from '../src/lib/coinbase.js';
import { setCatalogSymbols } from '../src/lib/price-symbols.js';
import { __resetThrottleForTest } from '../src/lib/price-resolver.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function perExchange(sym: string, exchange: string): { price: number; change24h: number; quote: string } | null {
  const raw = store.get(`price:${sym}:${exchange}`);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  store.clear();
  __resetThrottleForTest();
});

// ---------------------------------------------------------------------------
// Binance — parse a captured !ticker@arr array
// ---------------------------------------------------------------------------

describe('binance: !ticker@arr parse', () => {
  it('writes price:<BASE>:binance for catalog symbols, prefers USDT, skips the rest', async () => {
    setCatalogSymbols(['BTC', 'ETH', 'DOGE']);
    const client = new BinanceClient('ws://unused');

    // Captured all-market ticker frame (fields verified vs Binance docs:
    // s=symbol, c=last price, P=24h percent change).
    const frame = JSON.stringify([
      { e: '24hrTicker', s: 'BTCUSDT', c: '65000.50', P: '2.5' },
      { e: '24hrTicker', s: 'ETHUSDT', c: '3200.10', P: '-1.2' },
      { e: '24hrTicker', s: 'BTCUSDC', c: '65010.00', P: '2.6' }, // same base, thinner quote
      { e: '24hrTicker', s: 'ETHBTC', c: '0.05', P: '0.1' }, // crypto quote → skip
      { e: '24hrTicker', s: 'DOGEEUR', c: '0.10', P: '1.0' }, // EUR quote → skip
      { e: '24hrTicker', s: 'XYZUSDT', c: '1.00', P: '1.0' }, // not in catalog → skip
    ]);

    client.handleMessage(frame);
    await sleep(20);

    expect(perExchange('BTC', 'binance')).toMatchObject({ price: 65000.5, change24h: 2.5, quote: 'USDT' });
    expect(perExchange('ETH', 'binance')).toMatchObject({ price: 3200.1, change24h: -1.2, quote: 'USDT' });
    // DOGE only appeared as a EUR pair → no write
    expect(perExchange('DOGE', 'binance')).toBeNull();
    expect(store.get('price:XYZ:binance')).toBeUndefined();
  });

  it('USDT wins over USDC for the same base regardless of array order', async () => {
    setCatalogSymbols(['SOL']);
    const client = new BinanceClient('ws://unused');
    client.handleMessage(JSON.stringify([
      { s: 'SOLUSDC', c: '149.00', P: '1.0' },
      { s: 'SOLUSDT', c: '150.00', P: '1.1' },
    ]));
    await sleep(20);
    expect(perExchange('SOL', 'binance')).toMatchObject({ price: 150, quote: 'USDT' });
  });

  it('ignores a non-array frame (subscribe ack)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new BinanceClient('ws://unused');
    client.handleMessage(JSON.stringify({ result: null, id: 1 }));
    await sleep(10);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kraken — parse a captured ticker frame
// ---------------------------------------------------------------------------

describe('kraken: ticker parse', () => {
  it('writes price:<BASE>:kraken for catalog USD pairs, skips non-USD / non-catalog', async () => {
    setCatalogSymbols(['BTC', 'ETH', 'SOL']);
    const client = new KrakenClient('ws://unused');

    // Captured Kraken WS v2 ticker frame (fields verified vs Kraken docs:
    // symbol="BTC/USD", last, change_pct).
    const frame = JSON.stringify({
      channel: 'ticker',
      type: 'snapshot',
      data: [
        { symbol: 'BTC/USD', last: 65001.2, change_pct: 2.4 },
        { symbol: 'ETH/USD', last: 3201.5, change_pct: -1.1 },
        { symbol: 'SOL/EUR', last: 150, change_pct: 1.0 }, // EUR → skip
        { symbol: 'ZZZ/USD', last: 1, change_pct: 1.0 }, // not in catalog → skip
      ],
    });

    client.handleMessage(frame);
    await sleep(20);

    expect(perExchange('BTC', 'kraken')).toMatchObject({ price: 65001.2, change24h: 2.4, quote: 'USD' });
    expect(perExchange('ETH', 'kraken')).toMatchObject({ price: 3201.5, change24h: -1.1, quote: 'USD' });
    expect(perExchange('SOL', 'kraken')).toBeNull();
    expect(store.get('price:ZZZ:kraken')).toBeUndefined();
  });

  it('normalizes legacy XBT/USD → BTC', async () => {
    setCatalogSymbols(['BTC']);
    const client = new KrakenClient('ws://unused');
    client.handleMessage(JSON.stringify({
      channel: 'ticker',
      type: 'update',
      data: [{ symbol: 'XBT/USD', last: 64000, change_pct: 1.0 }],
    }));
    await sleep(20);
    expect(perExchange('BTC', 'kraken')).toMatchObject({ price: 64000, quote: 'USD' });
  });

  it('ignores non-ticker frames (heartbeat)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new KrakenClient('ws://unused');
    client.handleMessage(JSON.stringify({ channel: 'heartbeat' }));
    await sleep(10);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Connect + degraded-mode boot decision (mock ws servers)
// ---------------------------------------------------------------------------

describe('connect + BINANCE_ENABLED degraded mode', () => {
  let cbServer: WebSocketServer;
  let bnServer: WebSocketServer;
  let krServer: WebSocketServer;
  let cbUrl: string;
  let bnUrl: string;
  let krUrl: string;

  beforeAll(async () => {
    cbServer = new WebSocketServer({ port: 0 });
    bnServer = new WebSocketServer({ port: 0 });
    krServer = new WebSocketServer({ port: 0 });
    await Promise.all(
      [cbServer, bnServer, krServer].map((s) => new Promise<void>((r) => s.once('listening', r))),
    );
    cbUrl = `ws://127.0.0.1:${(cbServer.address() as AddressInfo).port}`;
    bnUrl = `ws://127.0.0.1:${(bnServer.address() as AddressInfo).port}`;
    krUrl = `ws://127.0.0.1:${(krServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(
      [cbServer, bnServer, krServer].map(
        (s) => new Promise<void>((res, rej) => s.close((e) => (e ? rej(e) : res()))),
      ),
    );
  });

  // Mirrors the boot decision in index.ts:startPriceFeeds — Binance is gated by
  // BINANCE_ENABLED; Coinbase + Kraken always connect.
  function bootFeeds(
    binanceEnabled: boolean,
    clients: { coinbase: CoinbaseClient; binance: BinanceClient; kraken: KrakenClient },
  ): void {
    clients.coinbase.connect();
    if (binanceEnabled) clients.binance.connect();
    clients.kraken.connect();
  }

  it('BINANCE_ENABLED=false → only Coinbase + Kraken connect', async () => {
    const clients = {
      coinbase: new CoinbaseClient(cbUrl),
      binance: new BinanceClient(bnUrl),
      kraken: new KrakenClient(krUrl),
    };
    let binanceConnections = 0;
    bnServer.on('connection', () => { binanceConnections++; });

    bootFeeds(false, clients);
    await sleep(150);

    expect(clients.coinbase.isConnected()).toBe(true);
    expect(clients.kraken.isConnected()).toBe(true);
    expect(clients.binance.isConnected()).toBe(false);
    expect(binanceConnections).toBe(0);

    clients.coinbase.disconnect();
    clients.kraken.disconnect();
    clients.binance.disconnect();
  });

  it('BINANCE_ENABLED=true → all three connect; Kraken sends the verified subscribe frame', async () => {
    const clients = {
      coinbase: new CoinbaseClient(cbUrl),
      binance: new BinanceClient(bnUrl),
      kraken: new KrakenClient(krUrl),
    };

    const krakenMsg = new Promise<string>((r) => krServer.once('connection', (ws: WsServer) => {
      ws.once('message', (d) => r(d.toString()));
    }));

    bootFeeds(true, clients);
    clients.kraken.subscribe(['BTC/USD', 'ETH/USD']);
    await sleep(150);

    expect(clients.coinbase.isConnected()).toBe(true);
    expect(clients.binance.isConnected()).toBe(true);
    expect(clients.kraken.isConnected()).toBe(true);

    const sub = JSON.parse(await krakenMsg) as {
      method: string;
      params: { channel: string; symbol: string[] };
    };
    expect(sub.method).toBe('subscribe');
    expect(sub.params.channel).toBe('ticker');
    expect(sub.params.symbol).toContain('BTC/USD');

    clients.coinbase.disconnect();
    clients.kraken.disconnect();
    clients.binance.disconnect();
  }, 5000);
});
