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
    // recordTick now batches its Redis ops via pipeline() (perf #6-8). These parse tests only
    // assert the per-exchange `price:<SYM>:<exchange>` writes, so the pipeline's set mirrors
    // `store`; the history (lpush/ltrim/expire) and publish are no-ops here.
    pipeline() {
      const results: Array<[null, unknown]> = [];
      const api: Record<string, unknown> = {};
      api.set = (key: string, val: string) => {
        store.set(key, val);
        results.push([null, 'OK']);
        return api;
      };
      api.mget = (...keys: string[]) => {
        results.push([null, keys.map((k) => store.get(k) ?? null)]);
        return api;
      };
      api.publish = () => { results.push([null, 1]); return api; };
      api.lpush = () => { results.push([null, 1]); return api; };
      api.ltrim = () => { results.push([null, 'OK']); return api; };
      api.expire = () => { results.push([null, 1]); return api; };
      api.exec = async () => results;
      return api;
    },
  },
}));

import { BinanceClient } from '../src/lib/binance.js';
import { KrakenClient } from '../src/lib/kraken.js';
import { CoinbaseClient } from '../src/lib/coinbase.js';
import { GateClient } from '../src/lib/gate.js';
import { KucoinClient } from '../src/lib/kucoin.js';
import { OkxClient } from '../src/lib/okx.js';
import { BybitClient } from '../src/lib/bybit.js';
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
// Kraken — bbo sub-feed (retrofit-35): event_trigger:'bbo' → (bid+ask)/2 mid,
// recorded under the 'kraken_bbo' source. Same frame schema as the trades feed.
// ---------------------------------------------------------------------------

describe('kraken: bbo sub-feed parse (retrofit-35)', () => {
  it("records price:<BASE>:kraken_bbo with the (bid+ask)/2 mid for a bbo client", async () => {
    setCatalogSymbols(['BTC']);
    const client = new KrakenClient('ws://unused', { eventTrigger: 'bbo', source: 'kraken_bbo' });

    client.handleMessage(JSON.stringify({
      channel: 'ticker',
      type: 'update',
      data: [{ symbol: 'BTC/USD', last: 65000, bid: 64999, ask: 65001, change_pct: 2.0 }],
    }));
    await sleep(20);

    // mid = (64999 + 65001) / 2 = 65000; stored under the bbo source, NOT 'kraken'.
    expect(perExchange('BTC', 'kraken_bbo')).toMatchObject({ price: 65000, change24h: 2.0, quote: 'USD' });
    expect(perExchange('BTC', 'kraken')).toBeNull();
  });

  it("a trades client still records the last price under 'kraken' (default behaviour unchanged)", async () => {
    setCatalogSymbols(['BTC']);
    const client = new KrakenClient('ws://unused'); // default eventTrigger:'trades', source:'kraken'

    client.handleMessage(JSON.stringify({
      channel: 'ticker',
      type: 'update',
      data: [{ symbol: 'BTC/USD', last: 64000, bid: 63999, ask: 64001, change_pct: 1.0 }],
    }));
    await sleep(20);

    expect(perExchange('BTC', 'kraken')).toMatchObject({ price: 64000, quote: 'USD' });
    expect(perExchange('BTC', 'kraken_bbo')).toBeNull();
  });

  it('skips a bbo frame missing bid/ask (cannot compute a mid)', async () => {
    setCatalogSymbols(['BTC', 'ETH']);
    const client = new KrakenClient('ws://unused', { eventTrigger: 'bbo', source: 'kraken_bbo' });

    client.handleMessage(JSON.stringify({
      channel: 'ticker',
      type: 'update',
      data: [
        { symbol: 'BTC/USD', last: 65000, change_pct: 1.0 }, // no bid/ask → skip
        { symbol: 'ETH/USD', last: 3200, bid: 0, ask: 3201, change_pct: 1.0 }, // bid ≤ 0 → skip
      ],
    }));
    await sleep(20);

    expect(perExchange('BTC', 'kraken_bbo')).toBeNull();
    expect(perExchange('ETH', 'kraken_bbo')).toBeNull();
  });

  it('sends event_trigger in the subscribe params (bbo vs trades)', () => {
    const sent: string[] = [];
    const bbo = new KrakenClient('ws://unused', { eventTrigger: 'bbo', source: 'kraken_bbo' });
    // Drive _sendSubscribe via a fake ws that captures frames.
    (bbo as unknown as { ws: { send: (s: string) => void }; state: string }).ws = {
      send: (s: string) => sent.push(s),
    };
    (bbo as unknown as { state: string }).state = 'connected';
    bbo.subscribe(['BTC/USD']);

    const frame = JSON.parse(sent[0]!) as { params: { channel: string; event_trigger: string } };
    expect(frame.params.channel).toBe('ticker');
    expect(frame.params.event_trigger).toBe('bbo');
  });
});

// ---------------------------------------------------------------------------
// Gate.io — parse a captured spot.tickers update (retrofit-36)
// ---------------------------------------------------------------------------

describe('gate.io: spot.tickers parse (retrofit-36)', () => {
  it('records price:<BASE>:gate for catalog USDT pairs; drops non-USDT / non-catalog', async () => {
    setCatalogSymbols(['BTC', 'ETH', 'PEPE']);
    const client = new GateClient('ws://unused');

    client.handleMessage(JSON.stringify({
      time: 1, channel: 'spot.tickers', event: 'update',
      result: { currency_pair: 'BTC_USDT', last: '65000.5', change_percentage: '2.5' },
    }));
    client.handleMessage(JSON.stringify({
      channel: 'spot.tickers', event: 'update',
      result: { currency_pair: 'ETH_BTC', last: '0.05', change_percentage: '1' }, // non-USDT → skip
    }));
    client.handleMessage(JSON.stringify({
      channel: 'spot.tickers', event: 'update',
      result: { currency_pair: 'XYZ_USDT', last: '1', change_percentage: '1' }, // not in catalog → skip
    }));
    await sleep(20);

    expect(perExchange('BTC', 'gate')).toMatchObject({ price: 65000.5, change24h: 2.5, quote: 'USDT' });
    expect(perExchange('ETH', 'gate')).toBeNull();
    expect(store.get('price:XYZ:gate')).toBeUndefined();
  });

  it('ignores subscribe-ack frames (event !== "update")', async () => {
    setCatalogSymbols(['BTC']);
    const client = new GateClient('ws://unused');
    client.handleMessage(JSON.stringify({
      channel: 'spot.tickers', event: 'subscribe', result: { status: 'success' },
    }));
    await sleep(10);
    expect(store.size).toBe(0);
  });

  it('ignores non-spot.tickers channels (spot.pong)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new GateClient('ws://unused');
    client.handleMessage(JSON.stringify({ channel: 'spot.pong', event: 'update' }));
    await sleep(10);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// KuCoin — parse a captured /market/snapshot:all message (retrofit-36)
// ---------------------------------------------------------------------------

describe('kucoin: snapshot:all parse (retrofit-36)', () => {
  it('records price:<BASE>:kucoin with lastTradedPrice + changeRate*100; drops non-catalog', async () => {
    setCatalogSymbols(['BTC', 'ETH']);
    const client = new KucoinClient();

    client.handleMessage(JSON.stringify({
      type: 'message', topic: '/market/snapshot:all', subject: 'BTC-USDT',
      data: { data: { symbol: 'BTC-USDT', lastTradedPrice: '65000.5', changeRate: '0.025' } },
    }));
    client.handleMessage(JSON.stringify({
      type: 'message', topic: '/market/snapshot:all', subject: 'XYZ-USDT',
      data: { data: { symbol: 'XYZ-USDT', lastTradedPrice: '1', changeRate: '0.01' } }, // not catalog
    }));
    await sleep(20);

    // changeRate is a FRACTION → 0.025 becomes +2.5%.
    expect(perExchange('BTC', 'kucoin')).toMatchObject({ price: 65000.5, change24h: 2.5, quote: 'USDT' });
    expect(store.get('price:XYZ:kucoin')).toBeUndefined();
  });

  it('drops non-USDT symbols', async () => {
    setCatalogSymbols(['ETH']);
    const client = new KucoinClient();
    client.handleMessage(JSON.stringify({
      type: 'message', topic: '/market/snapshot:all', subject: 'ETH-BTC',
      data: { data: { symbol: 'ETH-BTC', lastTradedPrice: '0.05', changeRate: '0.01' } },
    }));
    await sleep(10);
    expect(perExchange('ETH', 'kucoin')).toBeNull();
  });

  it('ignores pong/ack frames (no tick)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new KucoinClient();
    client.handleMessage(JSON.stringify({ type: 'pong' }));
    client.handleMessage(JSON.stringify({ type: 'ack', id: '1' }));
    await sleep(10);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// KuCoin — bullet → connect → welcome → subscribe sequence (retrofit-36)
// ---------------------------------------------------------------------------

describe('kucoin: connect sequence (retrofit-36)', () => {
  let kcServer: WebSocketServer;
  let kcUrl: string;

  beforeAll(async () => {
    kcServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => kcServer.once('listening', r));
    kcUrl = `ws://127.0.0.1:${(kcServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((res, rej) => kcServer.close((e) => (e ? rej(e) : res())));
  });

  it('fetches bullet, connects to the endpoint, and subscribes snapshot:all on welcome', async () => {
    const client = new KucoinClient({
      fetchBullet: async () => ({ token: 'tkn', endpoint: kcUrl, pingIntervalMs: 10_000 }),
    });

    const sub = new Promise<Record<string, unknown>>((resolve) => {
      kcServer.once('connection', (ws: WsServer) => {
        ws.send(JSON.stringify({ type: 'welcome', id: 'hello' })); // KuCoin greets on connect
        ws.on('message', (d) => {
          const m = JSON.parse(d.toString()) as Record<string, unknown>;
          if (m['type'] === 'subscribe') resolve(m);
        });
      });
    });

    client.connect();
    const frame = await sub;

    expect(frame['type']).toBe('subscribe');
    expect(frame['topic']).toBe('/market/snapshot:all');
    expect(client.isConnected()).toBe(true);

    client.disconnect();
  }, 5000);
});

// ---------------------------------------------------------------------------
// OKX — parse a captured tickers frame (retrofit-37)
// ---------------------------------------------------------------------------

describe('okx: tickers parse (retrofit-37)', () => {
  it('records price:<BASE>:okx with last + computed (last-open24h)/open24h*100; drops non-USDT/non-catalog', async () => {
    setCatalogSymbols(['BTC', 'ETH']);
    const client = new OkxClient('ws://unused');

    client.handleMessage(JSON.stringify({
      arg: { channel: 'tickers', instId: 'BTC-USDT' },
      data: [{ instId: 'BTC-USDT', last: '65000', open24h: '64000' }],
    }));
    client.handleMessage(JSON.stringify({
      arg: { channel: 'tickers', instId: 'ETH-BTC' }, // non-USDT → skip
      data: [{ instId: 'ETH-BTC', last: '0.05', open24h: '0.05' }],
    }));
    client.handleMessage(JSON.stringify({
      arg: { channel: 'tickers', instId: 'XYZ-USDT' }, // not catalog → skip
      data: [{ instId: 'XYZ-USDT', last: '1', open24h: '1' }],
    }));
    await sleep(20);

    // (65000 - 64000) / 64000 * 100 = 1.5625
    const btc = perExchange('BTC', 'okx');
    expect(btc?.price).toBe(65000);
    expect(btc?.change24h).toBeCloseTo(1.5625, 4);
    expect(btc?.quote).toBe('USDT');
    expect(perExchange('ETH', 'okx')).toBeNull();
    expect(store.get('price:XYZ:okx')).toBeUndefined();
  });

  it('change24h is 0 when open24h is missing/zero (no divide-by-zero)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new OkxClient('ws://unused');
    client.handleMessage(JSON.stringify({
      arg: { channel: 'tickers', instId: 'BTC-USDT' },
      data: [{ instId: 'BTC-USDT', last: '65000', open24h: '0' }],
    }));
    await sleep(20);
    expect(perExchange('BTC', 'okx')).toMatchObject({ price: 65000, change24h: 0 });
  });

  it('ignores the literal "pong" keepalive and non-tickers frames (no throw)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new OkxClient('ws://unused');
    expect(() => client.handleMessage('pong')).not.toThrow();
    expect(() => client.handleMessage(JSON.stringify({ event: 'subscribe', arg: { channel: 'tickers' } }))).not.toThrow();
    await sleep(10);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bybit — parse a captured tickers snapshot (retrofit-37)
// ---------------------------------------------------------------------------

describe('bybit: tickers snapshot parse (retrofit-37)', () => {
  it('records price:<BASE>:bybit with lastPrice + price24hPcnt*100; BASEQUOTE suffix parse', async () => {
    setCatalogSymbols(['BTC', 'ETH']);
    const client = new BybitClient('ws://unused');

    client.handleMessage(JSON.stringify({
      topic: 'tickers.BTCUSDT', type: 'snapshot',
      data: { symbol: 'BTCUSDT', lastPrice: '65000.5', price24hPcnt: '-0.0182' },
    }));
    await sleep(20);

    // price24hPcnt is a FRACTION → -0.0182 becomes -1.82%.
    const btc = perExchange('BTC', 'bybit');
    expect(btc?.price).toBe(65000.5);
    expect(btc?.change24h).toBeCloseTo(-1.82, 4);
    expect(btc?.quote).toBe('USDT');
  });

  it('drops non-USDT (e.g. USDC) and non-catalog symbols', async () => {
    setCatalogSymbols(['ETH']);
    const client = new BybitClient('ws://unused');
    client.handleMessage(JSON.stringify({
      topic: 'tickers.XYZUSDT', type: 'snapshot',
      data: { symbol: 'XYZUSDT', lastPrice: '1', price24hPcnt: '0.01' }, // not catalog
    }));
    client.handleMessage(JSON.stringify({
      topic: 'tickers.ETHUSDC', type: 'snapshot',
      data: { symbol: 'ETHUSDC', lastPrice: '3200', price24hPcnt: '0.01' }, // USDC → skip
    }));
    await sleep(10);
    expect(store.get('price:XYZ:bybit')).toBeUndefined();
    expect(perExchange('ETH', 'bybit')).toBeNull();
  });

  it('ignores pong / subscribe-ack frames (no tickers topic)', async () => {
    setCatalogSymbols(['BTC']);
    const client = new BybitClient('ws://unused');
    client.handleMessage(JSON.stringify({ op: 'pong', ret_msg: 'pong', success: true }));
    client.handleMessage(JSON.stringify({ op: 'subscribe', success: true, ret_msg: '' }));
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
