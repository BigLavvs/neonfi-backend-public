// Neonfi backend — OKX spot WebSocket client singleton (retrofit-37).
//
// OKX adds deep, fast coverage of majors/mid-caps and source redundancy (reachable when
// Binance isn't). Per-symbol subscriptions, so it needs a coverage list (catalog ∩ OKX
// SPOT USDT instruments), like Coinbase/Gate — NOT an all-market stream. Mirrors the
// Coinbase singleton resilience pattern plus OKX's literal-string "ping" keepalive.
//
// VERIFIED against https://www.okx.com/docs-v5/en/#public-data-websocket-tickers-channel
// (2026-06, public, no key):
//   - URL: wss://ws.okx.com:8443/ws/v5/public  (config.OKX_WS_URL)
//   - Subscribe: {"op":"subscribe","args":[{"channel":"tickers","instId":"BTC-USDT"}, ...]}
//   - Message:   {"arg":{"channel":"tickers","instId":"BTC-USDT"},
//                 "data":[{"instId":"BTC-USDT","last":"...","open24h":"...", ...}]}
//     `last` = last price. OKX tickers has NO direct 24h percent — compute it:
//     change24h = open24h > 0 ? (last - open24h) / open24h * 100 : 0.
//   - Symbols are `BASE-QUOTE` hyphen (spot); we keep only USDT (≈USD, no FX).
//   - Keepalive: if no data ~25s, send the literal string "ping" (NOT JSON); server
//     replies "pong". Any inbound frame proves liveness.

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import { isCatalogSymbol, getCatalogSymbols } from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// Message-driven liveness: no inbound frame for this long ⇒ dead ⇒ reconnect.
const HEARTBEAT_TIMEOUT_MS = 30_000;
// Send "ping" after this much idle (OKX drops a connection idle for ~30s).
const IDLE_PING_MS = 25_000;
// OKX accepts many args per subscribe; chunk to a safe size.
const SUBSCRIBE_CHUNK = 100;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class OkxClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  // The set of `BASE-USDT` instIds we cover; resubscribed verbatim on reconnect.
  private instIds: Set<string> = new Set();
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly idlePingMs: number;

  constructor(url?: string, opts?: { heartbeatTimeoutMs?: number; idlePingMs?: number }) {
    this.url = url ?? config.OKX_WS_URL;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.idlePingMs = opts?.idlePingMs ?? IDLE_PING_MS;
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
    this._clearIdlePingTimer();
    this._clearReconnectTimer();
    this.state = 'disconnected';
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }

  /**
   * Register coverage instIds (e.g. ["BTC-USDT","ETH-USDT"]). Sends the subscribe
   * immediately if connected; otherwise they go out on the next open.
   */
  subscribeForCoverage(instIds: string[]): void {
    const fresh: string[] = [];
    for (const id of instIds) {
      const instId = id.toUpperCase();
      if (!this.instIds.has(instId)) {
        this.instIds.add(instId);
        fresh.push(instId);
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
    console.log(JSON.stringify({ event: 'okx_connected', url: this.url }));
    this._resetHeartbeatTimer();
    this._resetIdlePingTimer();
    if (this.instIds.size) this._sendSubscribe([...this.instIds]);
  }

  private _sendSubscribe(instIds: string[]): void {
    if (!this.ws) return;
    for (let i = 0; i < instIds.length; i += SUBSCRIBE_CHUNK) {
      const chunk = instIds.slice(i, i + SUBSCRIBE_CHUNK);
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: chunk.map((instId) => ({ channel: 'tickers', instId })),
      }));
    }
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Any inbound frame (ticker, "pong", subscribe ack) proves liveness.
    this._resetHeartbeatTimer();
    this._resetIdlePingTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse an OKX tickers frame and push each catalog USDT tick to the resolver. Public so
   * tests can feed a captured frame without a live socket. Non-JSON frames (the literal
   * "pong") are ignored.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // "pong" and other non-JSON frames
    }
    const arg = msg['arg'] as { channel?: string } | undefined;
    if (!arg || arg.channel !== 'tickers') return; // ignore acks / other channels
    const data = msg['data'];
    if (!Array.isArray(data)) return;

    for (const el of data) {
      if (!el || typeof el !== 'object') continue;
      const d = el as Record<string, unknown>;
      const [base, quote] = String(d['instId'] ?? '').toUpperCase().split('-');
      if (!base || quote !== 'USDT') continue;
      if (!isCatalogSymbol(base)) continue;

      const price = parseFloat(String(d['last']));
      if (!Number.isFinite(price)) continue;
      const open = parseFloat(String(d['open24h']));
      const change24h = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;

      recordTick(base, 'okx', price, change24h, 'USDT').catch(
        (e: Error) => console.error(`[okx] recordTick ${base} error:`, e.message),
      );
    }
  }

  private _onClose(code?: number, reason?: string): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearHeartbeatTimer();
    this._clearIdlePingTimer();
    console.log(JSON.stringify({
      event: 'okx_disconnected',
      code: code ?? null,
      reason: reason ?? null,
      reconnectAttempts: this.reconnectAttempts,
    }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'okx_error', message: err.message }));
    // 'close' fires after 'error', so reconnect is scheduled there.
  }

  private _resetIdlePingTimer(): void {
    this._clearIdlePingTimer();
    this.idlePingTimer = setTimeout(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.send('ping'); // OKX wants the literal string, not JSON
      } catch {
        // ignore — a broken socket fires 'close'
      }
    }, this.idlePingMs);
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'okx_heartbeat_timeout' }));
      this.ws?.terminate();
    }, this.heartbeatTimeoutMs);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private _clearIdlePingTimer(): void {
    if (this.idlePingTimer) { clearTimeout(this.idlePingTimer); this.idlePingTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    this.state = 'reconnecting';
    this.reconnectAttempts++;

    if (this.reconnectAttempts >= RECONNECT_ALERT_AFTER_ATTEMPTS) {
      console.error(JSON.stringify({ event: 'okx_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'okx_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'okx_reconnecting' },
    })).catch((e: Error) => console.error('[okx] redis publish client_events error:', e.message));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }
}

export const okx = new OkxClient();

/**
 * Best-effort fetch of OKX's live SPOT USDT instruments (public REST, no key). Returns the
 * set of base symbols (uppercased); empty on any failure (boot then falls back to
 * subscribing the catalog `-USDT` instIds directly).
 */
export async function fetchOkxUsdtBaseSymbols(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT', {
      headers: { 'User-Agent': 'neonfi-backend' },
    });
    if (!res.ok) return out;
    const body = (await res.json()) as {
      data?: Array<{ baseCcy?: string; quoteCcy?: string; state?: string }>;
    };
    for (const inst of body.data ?? []) {
      if (inst.quoteCcy !== 'USDT') continue;
      if (inst.state && inst.state !== 'live') continue;
      if (inst.baseCcy) out.add(inst.baseCcy.toUpperCase());
    }
  } catch {
    // best-effort — boot continues by subscribing the catalog directly
  }
  return out;
}

/** Catalog ∩ OKX USDT instruments (or the whole catalog as `BASE-USDT` if `listed` empty). */
export function buildOkxCoverage(listed: Set<string>): string[] {
  const catalog = [...getCatalogSymbols()];
  const bases = listed.size ? catalog.filter((s) => listed.has(s)) : catalog;
  return bases.map((s) => `${s}-USDT`);
}
