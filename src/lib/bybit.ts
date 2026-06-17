// Neonfi backend — Bybit spot WebSocket client singleton (retrofit-37).
//
// Bybit adds deep, fast coverage of majors/mid-caps and source redundancy. Per-symbol
// subscriptions, so it needs a coverage list (catalog ∩ Bybit SPOT USDT instruments), like
// Coinbase/Gate/OKX — NOT an all-market stream. Mirrors the Coinbase singleton resilience
// pattern plus Bybit's {op:'ping'} keepalive.
//
// VERIFIED against https://bybit-exchange.github.io/docs/v5/websocket/public/ticker
// (2026-06, public):
//   - URL: wss://stream.bybit.com/v5/public/spot  (config.BYBIT_WS_URL)
//   - Subscribe: {"op":"subscribe","args":["tickers.BTCUSDT","tickers.ETHUSDT"]}  (chunk ≤10)
//   - Message (spot tickers push a full SNAPSHOT each time):
//     {"topic":"tickers.BTCUSDT","type":"snapshot",
//      "data":{"symbol":"BTCUSDT","lastPrice":"...","price24hPcnt":"-0.0182", ...}}
//     `lastPrice` = last; `price24hPcnt` = 24h change as a FRACTION → ×100 for percent.
//   - Symbols are concatenated `BASEQUOTE` (like Binance) → reuse the suffix-match parse
//     (fromBinanceSymbol); we keep only USDT (≈USD, no FX).
//   - Keepalive: send {"op":"ping"} ~every 20s; server replies {"op":"pong"} / ret_msg:"pong".

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import { fromBinanceSymbol, isCatalogSymbol, getCatalogSymbols } from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// Message-driven liveness: no inbound frame for this long ⇒ dead ⇒ reconnect.
const HEARTBEAT_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
// Bybit caps args per subscribe frame; chunk conservatively.
const SUBSCRIBE_CHUNK = 10;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class BybitClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  // The set of `tickers.<BASE>USDT` topics we cover; resubscribed verbatim on reconnect.
  private topics: Set<string> = new Set();
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly pingIntervalMs: number;

  constructor(url?: string, opts?: { heartbeatTimeoutMs?: number; pingIntervalMs?: number }) {
    this.url = url ?? config.BYBIT_WS_URL;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.pingIntervalMs = opts?.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this._open();
  }

  disconnect(): void {
    this._clearHeartbeatTimer();
    this._clearPingTimer();
    this._clearReconnectTimer();
    this.state = 'disconnected';
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }

  /**
   * Register coverage topics (e.g. ["tickers.BTCUSDT","tickers.ETHUSDT"]). Sends the
   * subscribe immediately if connected; otherwise they go out on the next open.
   */
  subscribeForCoverage(topics: string[]): void {
    const fresh: string[] = [];
    for (const t of topics) {
      if (!this.topics.has(t)) {
        this.topics.add(t);
        fresh.push(t);
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
    ws.on('close', (code: number, reason: Buffer) => this._onClose(code, reason?.toString()));
    ws.on('error', (err: Error) => this._onError(err));
  }

  private _onOpen(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    console.log(JSON.stringify({ event: 'bybit_connected', url: this.url }));
    this._resetHeartbeatTimer();
    this._startPing();
    if (this.topics.size) this._sendSubscribe([...this.topics]);
  }

  private _sendSubscribe(topics: string[]): void {
    if (!this.ws) return;
    for (let i = 0; i < topics.length; i += SUBSCRIBE_CHUNK) {
      const chunk = topics.slice(i, i + SUBSCRIBE_CHUNK);
      this.ws.send(JSON.stringify({ op: 'subscribe', args: chunk }));
    }
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Any inbound frame (snapshot, pong, subscribe ack) proves liveness.
    this._resetHeartbeatTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse a Bybit tickers snapshot and push the catalog USDT tick to the resolver. Public
   * so tests can feed a captured frame without a live socket.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    // pong / subscribe-ack frames carry op/success, not a tickers topic.
    const topic = msg['topic'];
    if (typeof topic !== 'string' || !topic.startsWith('tickers.')) return;
    const d = msg['data'];
    if (!d || typeof d !== 'object') return;
    const row = d as Record<string, unknown>;

    const norm = fromBinanceSymbol(String(row['symbol'] ?? ''));
    if (!norm || norm.quote !== 'USDT') return;
    if (!isCatalogSymbol(norm.base)) return;

    const price = parseFloat(String(row['lastPrice']));
    if (!Number.isFinite(price)) return;
    const pct = row['price24hPcnt'] != null ? parseFloat(String(row['price24hPcnt'])) * 100 : 0;

    recordTick(norm.base, 'bybit', price, Number.isFinite(pct) ? pct : 0, 'USDT').catch(
      (e: Error) => console.error(`[bybit] recordTick ${norm.base} error:`, e.message),
    );
  }

  private _onClose(code?: number, reason?: string): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearHeartbeatTimer();
    this._clearPingTimer();
    console.log(JSON.stringify({
      event: 'bybit_disconnected',
      code: code ?? null,
      reason: reason ?? null,
      reconnectAttempts: this.reconnectAttempts,
    }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'bybit_error', message: err.message }));
    // 'close' fires after 'error', so reconnect is scheduled there.
  }

  private _startPing(): void {
    this._clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      } catch {
        // ignore — a broken socket fires 'close'
      }
    }, this.pingIntervalMs);
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'bybit_heartbeat_timeout' }));
      this.ws?.terminate();
    }, this.heartbeatTimeoutMs);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private _clearPingTimer(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    this.state = 'reconnecting';
    this.reconnectAttempts++;

    if (this.reconnectAttempts >= RECONNECT_ALERT_AFTER_ATTEMPTS) {
      console.error(JSON.stringify({ event: 'bybit_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'bybit_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'bybit_reconnecting' },
    })).catch((e: Error) => console.error('[bybit] redis publish client_events error:', e.message));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }
}

export const bybit = new BybitClient();

/**
 * Best-effort fetch of Bybit's trading SPOT USDT instruments (public REST, no key). Returns
 * the set of base symbols (uppercased); empty on any failure (boot then falls back to
 * subscribing the catalog `tickers.<BASE>USDT` topics directly).
 */
export async function fetchBybitUsdtBaseSymbols(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await fetch('https://api.bybit.com/v5/market/instruments-info?category=spot', {
      headers: { 'User-Agent': 'neonfi-backend' },
    });
    if (!res.ok) return out;
    const body = (await res.json()) as {
      result?: { list?: Array<{ baseCoin?: string; quoteCoin?: string; status?: string }> };
    };
    for (const inst of body.result?.list ?? []) {
      if (inst.quoteCoin !== 'USDT') continue;
      if (inst.status && inst.status !== 'Trading') continue;
      if (inst.baseCoin) out.add(inst.baseCoin.toUpperCase());
    }
  } catch {
    // best-effort — boot continues by subscribing the catalog directly
  }
  return out;
}

/** Catalog ∩ Bybit USDT instruments (or the whole catalog as `tickers.<BASE>USDT` if empty). */
export function buildBybitCoverage(listed: Set<string>): string[] {
  const catalog = [...getCatalogSymbols()];
  const bases = listed.size ? catalog.filter((s) => listed.has(s)) : catalog;
  return bases.map((s) => `tickers.${s}USDT`);
}
