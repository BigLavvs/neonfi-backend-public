// Neonfi backend — Coinbase WebSocket client singleton (Stage 10A).
//
// Third singleton in the codebase (after Prisma + Redis). One persistent
// connection to COINBASE_WS_URL; reference-counted symbol subscriptions so
// many clients watching the same symbol result in ONE Coinbase subscription.
//
// Connection resilience (retrofit-33: Advanced Trade keepalive is the `heartbeats`
// channel + a message-driven liveness watchdog, NOT a WS protocol ping):
//   HEARTBEAT_TIMEOUT_MS = 10 000 — no inbound frame for this long ⇒ dead ⇒ reconnect
//   RECONNECT_BACKOFF_MS          — 1 / 2 / 4 / 8 / 16s, then cap at 30s
//   RECONNECT_ALERT_AFTER_ATTEMPTS = 5

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';

// Build Guide §6.4 — locked constants, do not promote to env vars
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;
// retrofit-33: Advanced Trade's keepalive is the `heartbeats` channel (server sends
// ~1/sec), NOT a WS protocol ping. Treat "no inbound frame for this long" as dead and
// force a reconnect. Replaces the old one-shot ws.ping()/pong-timeout machinery.
const HEARTBEAT_TIMEOUT_MS = 10_000;

// retrofit-31: prove ingestion. The first Coinbase tick actually recorded logs
// once at module scope — if `coinbase_first_tick` never appears, ingestion is
// dead even though the socket reports "connected".
let loggedFirstTick = false;

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class CoinbaseClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  private subscriptions: Map<string, number> = new Map();
  // Breadth coverage (retrofit-16): catalog products subscribed at boot on the
  // real-time `ticker` channel (retrofit-30 — was `ticker_batch` ~5s; now per-trade,
  // sub-second). Separate from the ref-counted subscriptions a Pro client watches,
  // but on the same channel, so they're effectively redundant — kept as documented.
  private coverageProducts: Set<string> = new Set();
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  // retrofit-33: liveness window, overridable in tests so the watchdog can be driven
  // in milliseconds instead of the production 10s.
  private readonly heartbeatTimeoutMs: number;

  constructor(url?: string, opts?: { heartbeatTimeoutMs?: number }) {
    this.url = url ?? config.COINBASE_WS_URL;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
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
    ws.on('close', (code: number, reason: Buffer) => this._onClose(code, reason?.toString()));
    ws.on('error', (err: Error) => this._onError(err));
  }

  private _onOpen(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    console.log(JSON.stringify({ event: 'coinbase_connected', url: this.url }));
    this._resetHeartbeatTimer();
    // Resubscribe to any symbols tracked before disconnect
    for (const [symbol] of this.subscriptions) {
      this._sendSubscribe(symbol);
    }
    // Resubscribe the breadth coverage set on the batched channel
    if (this.coverageProducts.size) {
      this._sendBatchSubscribe([...this.coverageProducts]);
    }
    // retrofit-33: subscribe Advanced Trade's official keepalive channel. Without it
    // Coinbase closes the socket after a short idle period (the flapping retrofit-33 fixes).
    this.ws?.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // retrofit-33: ANY inbound frame (heartbeat, ticker, ack) proves liveness, so reset
    // the message-driven watchdog here. Coinbase streams heartbeats ~1/sec plus ticker
    // data, so a gap longer than the window means the socket is dead.
    this._resetHeartbeatTimer();
    this.handleMessage(raw.toString());
  }

  /**
   * Parse a Coinbase Advanced Trade frame and push each USD ticker to the resolver.
   * Public so tests can feed a captured frame without a live socket (mirrors the
   * Kraken/Binance clients).
   *
   * retrofit-30: Advanced Trade routes on `msg.channel` (NOT `msg.type`) and nests
   * tickers under `events[].tickers[]`; the 24h change field is `price_percent_chg_24_h`
   * (underscores around `24` and `h`). The old code read the legacy Coinbase Pro shape
   * and therefore recorded ZERO ticks against `wss://advanced-trade-ws.coinbase.com`.
   */
  handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['channel'] as string) {
      case 'ticker': {
        const events = Array.isArray(msg['events']) ? (msg['events'] as unknown[]) : [];
        for (const evRaw of events) {
          if (!evRaw || typeof evRaw !== 'object') continue;
          const tickers = (evRaw as Record<string, unknown>)['tickers'];
          if (!Array.isArray(tickers)) continue;
          for (const tRaw of tickers) {
            if (!tRaw || typeof tRaw !== 'object') continue;
            const t = tRaw as Record<string, unknown>;

            const productId = t['product_id'] as string | undefined;
            if (!productId) continue;
            const [base, quote] = productId.split('-');
            if (!base) continue;

            const price = parseFloat(t['price'] as string);
            if (!Number.isFinite(price)) continue;

            const rawChange = t['price_percent_chg_24_h'];
            const change24h = rawChange != null ? parseFloat(String(rawChange)) : 0;

            // retrofit-31: beacon the very first recorded tick (module-scoped, once).
            if (!loggedFirstTick) {
              loggedFirstTick = true;
              console.log(JSON.stringify({ event: 'coinbase_first_tick', symbol: base.toUpperCase() }));
            }

            // retrofit-16: write the per-exchange key and let the resolver own the
            // canonical `price:<SYMBOL>` key + channel (no longer written here).
            recordTick(
              base.toUpperCase(),
              'coinbase',
              price,
              Number.isFinite(change24h) ? change24h : 0,
              (quote ?? 'USD').toUpperCase(),
            ).catch((e: Error) => console.error(`[coinbase] recordTick ${base} error:`, e.message));
          }
        }
        break;
      }

      case 'subscriptions': {
        // Subscribe acknowledgement — nothing to record. retrofit-31: surface how
        // many products Coinbase confirms on the `ticker` channel so a silent
        // zero-coverage subscribe is visible at boot.
        let confirmed = 0;
        const events = Array.isArray(msg['events']) ? (msg['events'] as unknown[]) : [];
        for (const evRaw of events) {
          if (!evRaw || typeof evRaw !== 'object') continue;
          const subs = (evRaw as Record<string, unknown>)['subscriptions'];
          if (!subs || typeof subs !== 'object') continue;
          const ticker = (subs as Record<string, unknown>)['ticker'];
          if (Array.isArray(ticker)) confirmed += ticker.length;
        }
        console.log(JSON.stringify({ event: 'coinbase_subscriptions_ack', confirmed }));
        break;
      }

      case 'heartbeats':
        // retrofit-33: keepalive frame — liveness already reset in _onMessage. No record.
        break;

      default: {
        // retrofit-31: Advanced Trade reports a rejected subscribe with NO `channel`
        // and a top-level `type:'error'` / `message` / `error` field — catch that
        // "subscribe rejected → 0 ingestion" case instead of letting it fall silently.
        if (
          msg['channel'] == null &&
          (msg['error'] != null || msg['message'] != null || msg['type'] === 'error')
        ) {
          const detail = String(msg['message'] ?? msg['error'] ?? raw).slice(0, 200);
          console.error(JSON.stringify({ event: 'coinbase_ws_error', detail }));
        }
        break;
      }
    }
  }

  private _onClose(code?: number, reason?: string): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearHeartbeatTimer();
    // retrofit-33: surface the close code/reason so a future drop is explainable
    // (e.g. 1006 abnormal vs a policy message) instead of an opaque reconnect loop.
    console.log(JSON.stringify({
      event: 'coinbase_disconnected',
      code: code ?? null,
      reason: reason ?? null,
      reconnectAttempts: this.reconnectAttempts,
    }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'coinbase_error', message: err.message }));
    // The 'close' event fires after 'error', so reconnect is triggered there
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      // No inbound frame within the window — the socket is dead even if the OS hasn't
      // noticed. terminate() fires 'close' → _onClose → reconnect.
      console.warn(JSON.stringify({ event: 'coinbase_heartbeat_timeout' }));
      this.ws?.terminate();
    }, this.heartbeatTimeoutMs);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    this.state = 'reconnecting';
    this.reconnectAttempts++;

    if (this.reconnectAttempts >= RECONNECT_ALERT_AFTER_ATTEMPTS) {
      console.error(JSON.stringify({ event: 'coinbase_reconnect_alert', attempts: this.reconnectAttempts }));
    }

    const idx = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx] ?? 30_000;

    console.log(JSON.stringify({ event: 'coinbase_reconnecting', attempt: this.reconnectAttempts, delayMs: delay }));

    // Notify connected WS clients of the upcoming reconnect gap
    redis.publish('client_events', JSON.stringify({
      type: 'reconnect',
      payload: { retryAfterMs: delay, reason: 'coinbase_reconnecting' },
    })).catch((e: Error) =>
      console.error('[coinbase] redis publish client_events error:', e.message),
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }

  async subscribeToSymbol(symbol: string): Promise<void> {
    const count = this.subscriptions.get(symbol) ?? 0;
    this.subscriptions.set(symbol, count + 1);
    if (count === 0 && this.state === 'connected') {
      this._sendSubscribe(symbol);
    }
  }

  async unsubscribeFromSymbol(symbol: string): Promise<void> {
    const count = this.subscriptions.get(symbol) ?? 0;
    if (count <= 1) {
      this.subscriptions.delete(symbol);
      if (this.state === 'connected') {
        this._sendUnsubscribe(symbol);
      }
    } else {
      this.subscriptions.set(symbol, count - 1);
    }
  }

  private _sendSubscribe(symbol: string): void {
    // retrofit-30: Advanced Trade uses singular `channel` (not the legacy `channels[]`).
    this.ws?.send(JSON.stringify({
      type: 'subscribe',
      product_ids: [`${symbol}-USD`],
      channel: 'ticker',
    }));
  }

  private _sendUnsubscribe(symbol: string): void {
    this.ws?.send(JSON.stringify({
      type: 'unsubscribe',
      product_ids: [`${symbol}-USD`],
      channel: 'ticker',
    }));
  }

  /**
   * Breadth coverage (retrofit-16): subscribe a set of Coinbase-listed catalog
   * symbols so the canonical cache carries true-USD prices beyond just the symbols
   * Pro clients actively watch. retrofit-30: uses the real-time `ticker` channel
   * (per-trade, sub-second) — NOT the old `ticker_batch` (~5s) — so the firehose
   * updates live. Pass the intersection of the catalog with Coinbase's product list
   * so we don't generate dead-product subscribe errors. Resubscribed on reconnect.
   */
  subscribeForCoverage(symbols: string[]): void {
    const fresh: string[] = [];
    for (const sym of symbols) {
      const product = `${sym.toUpperCase()}-USD`;
      if (!this.coverageProducts.has(product)) {
        this.coverageProducts.add(product);
        fresh.push(product);
      }
    }
    if (fresh.length && this.state === 'connected') {
      this._sendBatchSubscribe(fresh);
    }
  }

  private _sendBatchSubscribe(productIds: string[]): void {
    if (!this.ws || productIds.length === 0) return;
    // Chunk to keep each subscribe frame well under Coinbase's payload limit.
    const CHUNK = 100;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      // retrofit-30: real-time `ticker` channel (singular `channel`), not `ticker_batch`.
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: productIds.slice(i, i + CHUNK),
        channel: 'ticker',
      }));
    }
  }
}

export const coinbase = new CoinbaseClient();

/**
 * Best-effort fetch of Coinbase's online USD products (public REST, no key) so
 * boot can intersect the catalog with what Coinbase actually lists before
 * subscribing breadth coverage — avoiding dead-product subscribe errors.
 * Returns the set of base symbols (uppercased); empty set on any failure.
 */
export async function fetchCoinbaseUsdBaseSymbols(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await fetch('https://api.exchange.coinbase.com/products', {
      headers: { 'User-Agent': 'neonfi-backend' },
    });
    if (!res.ok) return out;
    const products = (await res.json()) as Array<{
      base_currency?: string;
      quote_currency?: string;
      status?: string;
      trading_disabled?: boolean;
    }>;
    for (const p of products) {
      if (p.quote_currency !== 'USD') continue;
      if (p.status && p.status !== 'online') continue;
      if (p.trading_disabled) continue;
      if (p.base_currency) out.add(p.base_currency.toUpperCase());
    }
  } catch {
    // best-effort — boot continues on Coinbase real-time + Binance + Kraken
  }
  return out;
}
