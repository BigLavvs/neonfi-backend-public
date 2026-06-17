// Neonfi backend — Gate.io spot WebSocket client singleton (retrofit-36).
//
// Gate.io lists THOUSANDS of long-tail tokens that Binance/Coinbase/Kraken don't
// quote in USD, and is reachable from this dev host — so it (with KuCoin) is what
// visibly un-freezes the catalog. Mirrors the Coinbase singleton resilience pattern
// (connect, exponential backoff, resubscribe-on-open, message-driven liveness),
// plus Gate's app-level `spot.ping` keepalive.
//
// VERIFIED against https://www.gate.io/docs/developers/apiv4/ws/en/ (2026-06, public,
// no key):
//   - URL: wss://api.gateio.ws/ws/v4/  (config.GATE_WS_URL)
//   - Subscribe: {"time":<unixS>,"channel":"spot.tickers","event":"subscribe",
//                 "payload":["BTC_USDT", ...]}   (chunk ≤100 pairs/frame)
//   - Update:    {"channel":"spot.tickers","event":"update",
//                 "result":{"currency_pair":"BTC_USDT","last":"...","change_percentage":"..."}}
//     All numeric fields are STRINGS. `last` = last price; `change_percentage` = 24h %.
//   - Keepalive: send {"time":<unixS>,"channel":"spot.ping"} (server replies spot.pong).
//   - Pairs are `BASE_QUOTE` underscore-delimited; we keep only USDT (≈USD, no FX).

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import { fromGatePair, toGatePair, isCatalogSymbol, getCatalogSymbols } from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// Message-driven liveness: no inbound frame for this long ⇒ dead ⇒ reconnect.
const HEARTBEAT_TIMEOUT_MS = 30_000;
// App-level keepalive ping cadence (Gate replies spot.pong; also keeps the watchdog fed
// during quiet stretches with no ticker traffic).
const PING_INTERVAL_MS = 15_000;
// Gate caps subscription payload size; chunk the pair list to stay well under it.
const SUBSCRIBE_CHUNK = 100;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class GateClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  // The set of `BASE_USDT` pairs we cover; resubscribed verbatim on reconnect.
  private pairs: Set<string> = new Set();
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly pingIntervalMs: number;

  constructor(url?: string, opts?: { heartbeatTimeoutMs?: number; pingIntervalMs?: number }) {
    this.url = url ?? config.GATE_WS_URL;
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
   * Register coverage pairs (e.g. ["BTC_USDT","ETH_USDT"]). Sends the subscribe
   * immediately if connected; otherwise they go out on the next open.
   */
  subscribeForCoverage(pairs: string[]): void {
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
    ws.on('close', (code: number, reason: Buffer) => this._onClose(code, reason?.toString()));
    ws.on('error', (err: Error) => this._onError(err));
  }

  private _onOpen(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    console.log(JSON.stringify({ event: 'gate_connected', url: this.url }));
    this._resetHeartbeatTimer();
    this._startPing();
    // Resubscribe the full coverage set after a (re)connect.
    if (this.pairs.size) this._sendSubscribe([...this.pairs]);
  }

  private _sendSubscribe(pairs: string[]): void {
    if (!this.ws) return;
    for (let i = 0; i < pairs.length; i += SUBSCRIBE_CHUNK) {
      const chunk = pairs.slice(i, i + SUBSCRIBE_CHUNK);
      this.ws.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: 'spot.tickers',
        event: 'subscribe',
        payload: chunk,
      }));
    }
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Any inbound frame (ticker, pong, subscribe ack) proves liveness.
    this._resetHeartbeatTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse a Gate.io spot.tickers update and push each catalog USDT tick to the resolver.
   * Public so tests can feed a captured frame without a live socket.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg['channel'] !== 'spot.tickers') return; // ignore spot.pong / other channels
    if (msg['event'] !== 'update') return; // ignore subscribe acks (event:"subscribe")

    const result = msg['result'];
    const rows = Array.isArray(result) ? result : result ? [result] : [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const t = r as Record<string, unknown>;
      const pair = t['currency_pair'] as string | undefined;
      if (!pair) continue;

      const norm = fromGatePair(pair);
      if (!norm || norm.quote !== 'USDT') continue;
      if (!isCatalogSymbol(norm.base)) continue;

      const price = parseFloat(String(t['last']));
      if (!Number.isFinite(price)) continue;
      const change24h = parseFloat(String(t['change_percentage']));

      recordTick(norm.base, 'gate', price, Number.isFinite(change24h) ? change24h : 0, 'USDT').catch(
        (e: Error) => console.error(`[gate] recordTick ${norm.base} error:`, e.message),
      );
    }
  }

  private _onClose(code?: number, reason?: string): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearHeartbeatTimer();
    this._clearPingTimer();
    console.log(JSON.stringify({
      event: 'gate_disconnected',
      code: code ?? null,
      reason: reason ?? null,
      reconnectAttempts: this.reconnectAttempts,
    }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'gate_error', message: err.message }));
    // 'close' fires after 'error', so reconnect is scheduled there.
  }

  private _startPing(): void {
    this._clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'spot.ping' }));
      } catch {
        // ignore — a broken socket fires 'close'
      }
    }, this.pingIntervalMs);
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'gate_heartbeat_timeout' }));
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
      console.error(JSON.stringify({ event: 'gate_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'gate_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'gate_reconnecting' },
    })).catch((e: Error) => console.error('[gate] redis publish client_events error:', e.message));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }
}

export const gate = new GateClient();

/**
 * Best-effort fetch of Gate.io's tradable USDT spot pairs (public REST, no key) so boot
 * can intersect the catalog with what Gate actually lists before subscribing — avoiding
 * dead-pair subscribes. Returns the set of base symbols (uppercased); empty on any failure
 * (boot then falls back to subscribing the catalog directly — Gate ignores unknown pairs).
 */
export async function fetchGateUsdtBaseSymbols(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await fetch('https://api.gateio.ws/api/v4/spot/currency_pairs', {
      headers: { 'User-Agent': 'neonfi-backend' },
    });
    if (!res.ok) return out;
    const pairs = (await res.json()) as Array<{
      base?: string;
      quote?: string;
      trade_status?: string;
    }>;
    for (const p of pairs) {
      if (p.quote !== 'USDT') continue;
      if (p.trade_status && p.trade_status !== 'tradable') continue;
      if (p.base) out.add(p.base.toUpperCase());
    }
  } catch {
    // best-effort — boot continues by subscribing the catalog directly
  }
  return out;
}

/** Catalog ∩ Gate USDT pairs (or the whole catalog as `BASE_USDT` if `listed` is empty). */
export function buildGateCoverage(listed: Set<string>): string[] {
  const catalog = [...getCatalogSymbols()];
  const bases = listed.size ? catalog.filter((s) => listed.has(s)) : catalog;
  return bases.map(toGatePair);
}
