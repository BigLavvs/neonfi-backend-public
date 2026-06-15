// Neonfi backend — Binance WebSocket client singleton (retrofit-16).
//
// Mirrors the Coinbase singleton resilience pattern (ping/pong heartbeat,
// exponential reconnect backoff, client_events reconnect publish). One
// connection to the all-market 24h ticker stream covers the WHOLE Binance
// catalog over a single subscription, pushing an array of every changed
// symbol's ticker ~once/sec.
//
// VERIFIED against official Binance Spot WS docs (2026-06, public market data,
// no key/auth):
//   - Base endpoint: wss://stream.binance.com:9443  (also :443)
//   - All-market 24h ticker stream name: !ticker@arr  → subscribed via the raw
//     stream path /ws/!ticker@arr (no SUBSCRIBE frame needed; reconnecting to
//     the same path auto-resubscribes).
//   - Each array element (24hrTicker): s=symbol (e.g. "BTCUSDT"), c=last price,
//     P=price change percent (24h). All numeric fields are strings.
//
// Binance is geo-restricted by the SERVER egress IP (not the user). With
// config.BINANCE_ENABLED=false the app degrades to Coinbase + Kraken (index.ts).

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import {
  fromBinanceSymbol,
  isCatalogSymbol,
  PREFERRED_BINANCE_QUOTES,
} from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class BinanceClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;

  constructor(url?: string) {
    this.url = url ?? config.BINANCE_WS_URL;
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
    console.log(JSON.stringify({ event: 'binance_connected', url: this.url }));
    this._schedulePing();
    // The all-market stream is selected by the URL path (/ws/!ticker@arr), so
    // reconnecting to the same URL auto-resubscribes — no SUBSCRIBE frame.
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Any inbound data proves the connection is alive (the firehose is ~1/sec).
    this._clearPongTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse one `!ticker@arr` array frame and push each catalog tick to the
   * resolver. Public so tests can feed a captured frame without a live socket.
   */
  handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // The firehose frame is an array; subscribe acks ({result, id}) are objects.
    if (!Array.isArray(parsed)) return;

    // Within one batch a base may trade against several preferred quotes
    // (BTCUSDT and BTCUSDC). Keep only the best-ranked quote so a thin pair
    // never overwrites the deep USDT price.
    const best = new Map<string, { quote: string; price: number; change24h: number; rank: number }>();

    for (const el of parsed) {
      if (!el || typeof el !== 'object') continue;
      const t = el as Record<string, unknown>;
      const symbol = t['s'] as string | undefined;
      const lastPrice = t['c'] as string | undefined;
      if (!symbol || !lastPrice) continue;

      const norm = fromBinanceSymbol(symbol);
      if (!norm) continue; // non-preferred quote
      if (!isCatalogSymbol(norm.base)) continue;

      const price = parseFloat(lastPrice);
      if (!Number.isFinite(price)) continue;
      const rawChange = t['P'] as string | undefined;
      const change24h = rawChange ? parseFloat(rawChange) : 0;

      const rank = PREFERRED_BINANCE_QUOTES.indexOf(norm.quote);
      const existing = best.get(norm.base);
      if (existing && existing.rank <= rank) continue;
      best.set(norm.base, { quote: norm.quote, price, change24h, rank });
    }

    for (const [base, v] of best) {
      recordTick(base, 'binance', v.price, v.change24h, v.quote).catch((e: Error) =>
        console.error(`[binance] recordTick ${base} error:`, e.message),
      );
    }
  }

  private _onClose(): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearPingTimer();
    this._clearPongTimer();
    console.log(JSON.stringify({ event: 'binance_disconnected', reconnectAttempts: this.reconnectAttempts }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'binance_error', message: err.message }));
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
        console.warn(JSON.stringify({ event: 'binance_pong_timeout' }));
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
      console.error(JSON.stringify({ event: 'binance_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'binance_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'binance_reconnecting' },
    })).catch((e: Error) =>
      console.error('[binance] redis publish client_events error:', e.message),
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }
}

export const binance = new BinanceClient();
