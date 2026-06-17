// Neonfi backend — Kraken WebSocket v2 client singleton (retrofit-16).
//
// Mirrors the Coinbase singleton resilience pattern. Kraken has NO single
// all-market stream, so we subscribe the `ticker` channel for an explicit list
// of USD pairs = (catalog symbols ∩ Kraken-listed), capped to the top ~300 by
// rank (price-symbols.getKrakenCoverage). Kraken provides a true-USD cross-check.
//
// VERIFIED against official Kraken WS v2 docs (2026-06, public market data, no
// key/auth):
//   - URL: wss://ws.kraken.com/v2
//   - Subscribe: {"method":"subscribe","params":{"channel":"ticker",
//                 "symbol":["BTC/USD", ...],"event_trigger":"trades"|"bbo"}}
//   - Ticker frame: {"channel":"ticker","type":"snapshot"|"update",
//                 "data":[{"symbol":"BTC/USD","last":<num>,"bid":<num>,"ask":<num>,
//                          "change_pct":<num>,...}]}
//     last      = last traded price
//     bid / ask = best bid / ask (used for the bbo-mid sub-feed)
//     change_pct = 24-hour price change in percentage points
//   - Pairs are slash-delimited and normalized (BTC/USD, not legacy XBT/USD).
//
// retrofit-35: the same class drives TWO singletons — `kraken` (event_trigger:'trades',
// last-trade price, source 'kraken') and `krakenBbo` (event_trigger:'bbo', (bid+ask)/2
// mid price, source 'kraken_bbo'). The `ticker` channel accepts event_trigger 'bbo'|'trades'
// (default 'trades') with an IDENTICAL frame schema. This is a deliberate, scoped reversal
// of retrofit-32's "no bbo" stance, mitigated by the resolver merge that prefers the last
// trade and only surfaces the bbo-mid when it is MORE current (price-resolver.ts).

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import { fromKrakenName, isCatalogSymbol } from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// Kraken caps subscription payload size; chunk the pair list to stay well under it.
const SUBSCRIBE_CHUNK = 100;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class KrakenClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  // The set of `SYM/USD` pairs we cover; resubscribed verbatim on reconnect.
  private pairs: Set<string> = new Set();
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  // retrofit-35: which Kraken sub-feed this instance drives. 'trades' (default) records the
  // last-trade price under source 'kraken'; 'bbo' records the (bid+ask)/2 mid under 'kraken_bbo'.
  private readonly eventTrigger: 'trades' | 'bbo';
  private readonly source: string;

  constructor(url?: string, opts?: { eventTrigger?: 'trades' | 'bbo'; source?: string }) {
    this.url = url ?? config.KRAKEN_WS_URL;
    this.eventTrigger = opts?.eventTrigger ?? 'trades';
    this.source = opts?.source ?? 'kraken';
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this._open();
  }

  disconnect(): void {
    this._clearPingTimer();
    this._clearPongTimer();
    this._clearReconnectTimer();
    this.state = 'disconnected';
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }

  /**
   * Register coverage pairs (e.g. ["BTC/USD","ETH/USD"]). Sends the subscribe
   * immediately if connected; otherwise they go out on the next open.
   */
  subscribe(pairs: string[]): void {
    const fresh: string[] = [];
    for (const p of pairs) {
      const pair = p.toUpperCase();
      if (!this.pairs.has(pair)) {
        this.pairs.add(pair);
        fresh.push(pair);
      }
    }
    if (fresh.length && this.state === 'connected') {
      this._sendSubscribe(fresh);
    }
  }

  private _open(): void {
    this.state = 'connecting';
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => this._onOpen());
    ws.on('message', (data: WebSocket.RawData) => this._onMessage(data));
    ws.on('pong', () => this._clearPongTimer());
    ws.on('close', () => this._onClose());
    ws.on('error', (err: Error) => this._onError(err));
  }

  private _onOpen(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    console.log(JSON.stringify({ event: 'kraken_connected', url: this.url }));
    this._schedulePing();
    // Resubscribe the full coverage set after a (re)connect.
    if (this.pairs.size) this._sendSubscribe([...this.pairs]);
  }

  private _sendSubscribe(pairs: string[]): void {
    if (!this.ws) return;
    for (let i = 0; i < pairs.length; i += SUBSCRIBE_CHUNK) {
      const chunk = pairs.slice(i, i + SUBSCRIBE_CHUNK);
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: chunk, event_trigger: this.eventTrigger },
      }));
    }
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Kraken emits a `heartbeat` frame ~1/sec when idle; any inbound data proves
    // the connection is alive.
    this._clearPongTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse a Kraken ticker frame and push each catalog USD tick to the resolver.
   * Public so tests can feed a captured frame without a live socket.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg['channel'] !== 'ticker') return;
    const data = msg['data'];
    if (!Array.isArray(data)) return;

    for (const el of data) {
      if (!el || typeof el !== 'object') continue;
      const t = el as Record<string, unknown>;
      const symbol = t['symbol'] as string | undefined;
      if (!symbol) continue;

      const norm = fromKrakenName(symbol);
      if (!norm) continue;
      if (norm.quote !== 'USD') continue; // we only cover USD pairs
      if (!isCatalogSymbol(norm.base)) continue;

      // retrofit-35: pick the price by sub-feed mode. 'trades' → last-trade; 'bbo' →
      // (bid+ask)/2 mid, skipping the frame if either side is missing/non-finite/≤0.
      let price: number;
      if (this.eventTrigger === 'bbo') {
        const bid = typeof t['bid'] === 'number' ? (t['bid'] as number) : parseFloat(String(t['bid']));
        const ask = typeof t['ask'] === 'number' ? (t['ask'] as number) : parseFloat(String(t['ask']));
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
        price = (bid + ask) / 2;
      } else {
        price = typeof t['last'] === 'number' ? (t['last'] as number) : parseFloat(String(t['last']));
      }
      if (!Number.isFinite(price)) continue;
      const rawChange = t['change_pct'];
      const change24h = typeof rawChange === 'number' ? rawChange : parseFloat(String(rawChange));

      recordTick(norm.base, this.source, price, Number.isFinite(change24h) ? change24h : 0, 'USD').catch(
        (e: Error) => console.error(`[kraken] recordTick ${norm.base} error:`, e.message),
      );
    }
  }

  private _onClose(): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearPingTimer();
    this._clearPongTimer();
    console.log(JSON.stringify({ event: 'kraken_disconnected', reconnectAttempts: this.reconnectAttempts }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'kraken_error', message: err.message }));
    // 'close' fires after 'error', so reconnect is scheduled there.
  }

  private _schedulePing(): void {
    this._clearPingTimer();
    this.pingTimer = setTimeout(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.ping();
      } catch {
        // ignore — a broken socket fires 'close'
      }
      this.pongTimer = setTimeout(() => {
        console.warn(JSON.stringify({ event: 'kraken_pong_timeout' }));
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private _clearPingTimer(): void {
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
  }

  private _clearPongTimer(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    this.state = 'reconnecting';
    this.reconnectAttempts++;

    if (this.reconnectAttempts >= RECONNECT_ALERT_AFTER_ATTEMPTS) {
      console.error(JSON.stringify({ event: 'kraken_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'kraken_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'kraken_reconnecting' },
    })).catch((e: Error) =>
      console.error('[kraken] redis publish client_events error:', e.message),
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }
}

export const kraken = new KrakenClient(); // trades → 'kraken'
// retrofit-35: bbo-mid sub-feed. The resolver merges it into the 'kraken' candidate, using it
// only when it is more current than the last trade (keeps thin Kraken pairs live).
export const krakenBbo = new KrakenClient(undefined, {
  eventTrigger: 'bbo',
  source: 'kraken_bbo',
});
