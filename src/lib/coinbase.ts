// Neonfi backend — Coinbase WebSocket client singleton (Stage 10A).
//
// Third singleton in the codebase (after Prisma + Redis). One persistent
// connection to COINBASE_WS_URL; reference-counted symbol subscriptions so
// many clients watching the same symbol result in ONE Coinbase subscription.
//
// Connection resilience constants are locked by Build Guide §6.4:
//   PING_INTERVAL_MS = 30 000   — heartbeat cadence
//   PONG_TIMEOUT_MS  = 5 000    — treat as dead if no pong within this window
//   RECONNECT_BACKOFF_MS        — 1 / 2 / 4 / 8 / 16s, then cap at 30s
//   RECONNECT_ALERT_AFTER_ATTEMPTS = 5

import WebSocket from 'ws';
import { redis } from './redis.js';
import { config } from './config.js';
import { recordTick } from './price-resolver.js';

// Build Guide §6.4 — locked constants, do not promote to env vars
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONNECT_ALERT_AFTER_ATTEMPTS = 5;

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
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;

  constructor(url?: string) {
    this.url = url ?? config.COINBASE_WS_URL;
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
    console.log(JSON.stringify({ event: 'coinbase_connected', url: this.url }));
    this._schedulePing();
    // Resubscribe to any symbols tracked before disconnect
    for (const [symbol] of this.subscriptions) {
      this._sendSubscribe(symbol);
    }
    // Resubscribe the breadth coverage set on the batched channel
    if (this.coverageProducts.size) {
      this._sendBatchSubscribe([...this.coverageProducts]);
    }
  }

  private _onMessage(raw: WebSocket.RawData): void {
    // retrofit-30: ANY inbound frame proves liveness. Advanced Trade sends
    // `channel:'heartbeats'`/`'subscriptions'`/`'ticker'` — never the legacy
    // `type:'heartbeat'` — so reset the pong timer here, not in a dead message branch.
    this._clearPongTimer();
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

      case 'subscriptions':
        // Subscribe acknowledgement — nothing to record.
        break;

      default:
        break;
    }
  }

  private _onClose(): void {
    if (this.state === 'disconnected') return; // intentional disconnect
    this._clearPingTimer();
    this._clearPongTimer();
    console.log(JSON.stringify({ event: 'coinbase_disconnected', reconnectAttempts: this.reconnectAttempts }));
    this._scheduleReconnect();
  }

  private _onError(err: Error): void {
    console.error(JSON.stringify({ event: 'coinbase_error', message: err.message }));
    // The 'close' event fires after 'error', so reconnect is triggered there
  }

  private _schedulePing(): void {
    this._clearPingTimer();
    this.pingTimer = setTimeout(() => {
      if (this.state !== 'connected' || !this.ws) return;
      try {
        this.ws.ping();
      } catch {
        // ignore — if WS is broken the close event will fire
      }
      this.pongTimer = setTimeout(() => {
        console.warn(JSON.stringify({ event: 'coinbase_pong_timeout' }));
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
