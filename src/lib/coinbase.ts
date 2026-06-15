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
  // lighter `ticker_batch` channel (~5s). Separate from the ref-counted
  // real-time `ticker` subscriptions a Pro client actively watches.
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
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type'] as string) {
      case 'heartbeat':
        // JSON-level heartbeat from Coinbase also resets the pong timer
        this._clearPongTimer();
        break;

      case 'ticker': {
        const productId = msg['product_id'] as string | undefined;
        if (!productId) break;
        const [base, quote] = productId.split('-');
        if (!base) break;
        const symbol = base.toUpperCase();
        const rawPrice = msg['price'] as string | undefined;
        if (!rawPrice) break;
        const price = parseFloat(rawPrice);
        // Coinbase Advanced Trade uses price_percent_chg_24h; fallback to 0
        const rawChange = msg['price_percent_chg_24h'] as string | undefined;
        const change24h = rawChange ? parseFloat(rawChange) : 0;

        // retrofit-16: write the per-exchange key and let the resolver own the
        // canonical `price:<SYMBOL>` key + channel (no longer written here).
        recordTick(symbol, 'coinbase', price, change24h, (quote ?? 'USD').toUpperCase()).catch(
          (e: Error) => console.error(`[coinbase] recordTick ${symbol} error:`, e.message),
        );
        break;
      }

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
    this.ws?.send(JSON.stringify({
      type: 'subscribe',
      product_ids: [`${symbol}-USD`],
      channels: ['ticker'],
    }));
  }

  private _sendUnsubscribe(symbol: string): void {
    this.ws?.send(JSON.stringify({
      type: 'unsubscribe',
      product_ids: [`${symbol}-USD`],
      channels: ['ticker'],
    }));
  }

  /**
   * Breadth coverage (retrofit-16): subscribe a set of Coinbase-listed catalog
   * symbols on the lighter `ticker_batch` channel (~5s) so the canonical cache
   * carries true-USD prices beyond just the symbols Pro clients actively watch.
   * Pass the intersection of the catalog with Coinbase's product list so we
   * don't generate dead-product subscribe errors. Resubscribed on reconnect.
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
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: productIds.slice(i, i + CHUNK),
        channels: ['ticker_batch'],
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
