// Neonfi backend — KuCoin spot WebSocket client singleton (retrofit-36).
//
// KuCoin streams the WHOLE market over one topic, so (with Gate.io) it un-freezes the
// long-tail catalog. Its connect flow is UNIQUE — there is no static WS URL:
//   1. POST bullet-public (no auth) → { data: { token, instanceServers:[{endpoint,
//      pingInterval, pingTimeout}] } }
//   2. Connect to `${endpoint}?token=${token}&connectId=${uuid}`; server sends
//      {type:'welcome'}.
//   3. App-level ping {id,type:'ping'} every pingInterval (~18s); server replies
//      {type:'pong'}. Missing pings → server closes (this replaces ws.ping()).
//   4. Subscribe {id,type:'subscribe',topic:'/market/snapshot:all',response:true} — the
//      snapshot topic carries BOTH last price and 24h change.
//   5. Message: {type:'message', topic:'/market/snapshot:all', subject:'BTC-USDT',
//      data:{ data:{ symbol, lastTradedPrice, changeRate } }}. `changeRate` is a FRACTION
//      (0.012 = +1.2%) → ×100 for the percent we store.
//
// VERIFIED against https://www.kucoin.com/docs/websocket/ (2026-06, public). Symbols are
// `BASE-QUOTE` hyphen-delimited; we keep only USDT (≈USD, no FX). Because the whole market
// streams, there is no coverage list — incoming ticks are FILTERED to the catalog.

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';
import { fromKucoinSymbol, isCatalogSymbol } from './price-symbols.js';

// Same locked resilience constants as the Coinbase client (Build Guide §6.4).
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// Message-driven liveness: no inbound frame for this long ⇒ dead ⇒ reconnect.
const HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 18_000;
const SNAPSHOT_TOPIC = '/market/snapshot:all';

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface KucoinBullet {
  token: string;
  endpoint: string;
  pingIntervalMs: number;
}

/**
 * Default bullet-public fetch: POST the (no-auth) bullet endpoint and pluck the token +
 * first instance server. Overridable in tests so the connect flow can be driven without a
 * real KuCoin round-trip.
 */
export async function fetchKucoinBullet(url: string): Promise<KucoinBullet> {
  const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'neonfi-backend' } });
  if (!res.ok) throw new Error(`kucoin bullet-public HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { token?: string; instanceServers?: Array<{ endpoint?: string; pingInterval?: number }> };
  };
  const token = body.data?.token;
  const server = body.data?.instanceServers?.[0];
  if (!token || !server?.endpoint) throw new Error('kucoin bullet-public: missing token/endpoint');
  return {
    token,
    endpoint: server.endpoint,
    pingIntervalMs: server.pingInterval ?? DEFAULT_PING_INTERVAL_MS,
  };
}

export class KucoinClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  private readonly bulletUrl: string;
  private readonly fetchBullet: (url: string) => Promise<KucoinBullet>;
  private readonly heartbeatTimeoutMs: number;

  constructor(opts?: {
    bulletUrl?: string;
    fetchBullet?: (url: string) => Promise<KucoinBullet>;
    heartbeatTimeoutMs?: number;
  }) {
    this.bulletUrl = opts?.bulletUrl ?? config.KUCOIN_BULLET_URL;
    this.fetchBullet = opts?.fetchBullet ?? fetchKucoinBullet;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    void this._open();
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

  private async _open(): Promise<void> {
    this.state = 'connecting';
    let bullet: KucoinBullet;
    try {
      // Token is short-lived — re-fetched on every (re)connect.
      bullet = await this.fetchBullet(this.bulletUrl);
    } catch (e) {
      console.error(JSON.stringify({ event: 'kucoin_bullet_failed', message: (e as Error).message }));
      this._scheduleReconnect();
      return;
    }
    this.pingIntervalMs = bullet.pingIntervalMs;
    const url = `${bullet.endpoint}?token=${encodeURIComponent(bullet.token)}&connectId=${randomUUID()}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => this._onOpen());
    ws.on('message', (data: WebSocket.RawData) => this._onMessage(data));
    ws.on('close', (code: number, reason: Buffer) => this._onClose(code, reason?.toString()));
    ws.on('error', (err: Error) => this._onError(err));
  }

  private _onOpen(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    console.log(JSON.stringify({ event: 'kucoin_connected' }));
    this._resetHeartbeatTimer();
    // Subscribe + ping are kicked off when the {type:'welcome'} frame arrives (the
    // documented "session ready" signal).
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // Any inbound frame (welcome, pong, snapshot) proves liveness.
    this._resetHeartbeatTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse a KuCoin frame. Public so tests can drive welcome→subscribe and the snapshot
   * record path without a live socket.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type'] as string) {
      case 'welcome':
        // Session ready → subscribe the all-market snapshot + start the app-level ping.
        this._sendSubscribe();
        this._startPing();
        return;
      case 'pong':
      case 'ack':
        return; // liveness already reset; nothing to record
      case 'message':
        break;
      default:
        return;
    }

    if (msg['topic'] !== SNAPSHOT_TOPIC) return;
    // snapshot:all nests the ticker under data.data.
    const outer = msg['data'];
    if (!outer || typeof outer !== 'object') return;
    const d = (outer as Record<string, unknown>)['data'];
    if (!d || typeof d !== 'object') return;
    const row = d as Record<string, unknown>;

    const symbol = (row['symbol'] as string | undefined) ?? (msg['subject'] as string | undefined);
    if (!symbol) return;
    const norm = fromKucoinSymbol(symbol);
    if (!norm || norm.quote !== 'USDT') return;
    if (!isCatalogSymbol(norm.base)) return;

    const price = parseFloat(String(row['lastTradedPrice']));
    if (!Number.isFinite(price)) return;
    const change24h = row['changeRate'] != null ? parseFloat(String(row['changeRate'])) * 100 : 0;

    recordTick(norm.base, 'kucoin', price, Number.isFinite(change24h) ? change24h : 0, 'USDT').catch(
      (e: Error) => console.error(`[kucoin] recordTick ${norm.base} error:`, e.message),
    );
  }

  private _sendSubscribe(): void {
    this.ws?.send(JSON.stringify({
      id: Date.now(),
      type: 'subscribe',
      topic: SNAPSHOT_TOPIC,
      response: true,
    }));
  }

  private _startPing(): void {
    this._clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
      } catch {
        // ignore — a broken socket fires 'close'
      }
    }, this.pingIntervalMs);
  }

  private _onClose(code?: number, reason?: string): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearHeartbeatTimer();
    this._clearPingTimer();
    console.log(JSON.stringify({
      event: 'kucoin_disconnected',
      code: code ?? null,
      reason: reason ?? null,
      reconnectAttempts: this.reconnectAttempts,
    }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'kucoin_error', message: err.message }));
    // 'close' fires after 'error', so reconnect is scheduled there.
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'kucoin_heartbeat_timeout' }));
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
      console.error(JSON.stringify({ event: 'kucoin_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'kucoin_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'kucoin_reconnecting' },
    })).catch((e: Error) => console.error('[kucoin] redis publish client_events error:', e.message));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._open();
    }, delay);
  }
}

export const kucoin = new KucoinClient();
