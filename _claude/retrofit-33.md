# retrofit-33 — Stop the Coinbase WS flapping (heartbeats keepalive + close visibility)

## Why (from the boot logs)
```
{"event":"coinbase_connected"}
{"event":"coinbase_first_tick","symbol":"DOGE"}      ← ingestion works...
{"event":"coinbase_subscriptions_ack","confirmed":26}
{"event":"coinbase_disconnected","reconnectAttempts":0}   ← ...then the socket drops
{"event":"coinbase_reconnecting","attempt":1,"delayMs":1000}
{"event":"coinbase_connected"}
{"event":"coinbase_subscriptions_ack","confirmed":26}
```
Coinbase connects, subscribes 26, delivers a tick, then **drops and reconnects** — repeatedly. Because
it's not connected steadily, the firehose stays on Kraken (measured: Coinbase-active LINK/ATOM ≈ 0 in
the live stream while Coinbase streams them 10–28×/10s directly). Two gaps cause this:

1. **No `heartbeats` subscription.** Coinbase Advanced Trade's official keepalive is the `heartbeats`
   channel (server sends ~1/sec). retrofit-31 deliberately skipped it. Without it, Coinbase closes the
   connection.
2. **The client "heartbeat" is a one-shot WS protocol ping** (`_schedulePing` fires `ws.ping()` once at
   30s and never reschedules), which Coinbase Advanced Trade doesn't use for keepalive anyway.

We also can't see *why* the socket closes — `_onClose` logs no code/reason.

## Changes — `src/lib/coinbase.ts` only

1. **Subscribe `heartbeats` on open.** In `_onOpen`, after the coverage resubscribe, send:
   ```ts
   this.ws?.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
   ```

2. **Replace the one-shot ping with a message-driven liveness watchdog.** Coinbase sends heartbeats
   (and ticker data) continuously, so treat "no inbound frame for N seconds" as dead:
   - Remove the `_schedulePing` / `pongTimer` / `ws.ping()` machinery (and the `'pong'` listener).
   - Add `HEARTBEAT_TIMEOUT_MS = 10_000` and a `heartbeatTimer`. Start/reset it on every inbound
     frame (`handleMessage` already runs on every message — reset there, or in `_onMessage`). On
     timeout: `console.warn(JSON.stringify({event:'coinbase_heartbeat_timeout'}))` then
     `this.ws?.terminate()` (which triggers `_onClose` → reconnect).
   - Clear `heartbeatTimer` in `disconnect()` and on close.
   - Keep `PING_INTERVAL_MS`/`PONG_TIMEOUT_MS` constants only if still referenced; otherwise remove.

3. **Route `heartbeats` frames** in `handleMessage`: `case 'heartbeats':` → do nothing except the
   liveness reset (already covered if you reset on every frame). Must NOT call `recordTick`.

4. **Log the close code + reason** so a future drop is explainable. Change the close wiring:
   ```ts
   ws.on('close', (code: number, reason: Buffer) => this._onClose(code, reason?.toString()));
   ```
   and in `_onClose(code?, reason?)`:
   ```ts
   console.log(JSON.stringify({ event:'coinbase_disconnected', code: code ?? null, reason: reason ?? null, reconnectAttempts: this.reconnectAttempts }));
   ```
   Keep the existing reconnect/backoff logic.

5. Leave the ticker parse + subscribe format (retrofit-30) and the coverage/first-tick logging
   (retrofit-31) untouched. Kraken/binance/resolver untouched.

## Tests — `tests/coinbase.test.ts`
- `_onOpen` (after connect) sends a `{channel:'heartbeats'}` subscribe (capture sent frames on the
  fake ws — mirror test 243's approach).
- A `{channel:'heartbeats', ...}` frame → no `recordTick`, no throw.
- The liveness watchdog: with injectable timing or a short override, prove no inbound frame within the
  window triggers a terminate/reconnect, and that any frame resets it. (If timing is awkward to test
  deterministically, at minimum assert the heartbeats subscribe + heartbeats-frame no-op, and leave a
  comment.)
- Keep 233–246 green. `tsc --noEmit`, coinbase suite, `NODE_ENV=test`, dev stopped. Commit
  `src/lib/coinbase.ts` + `tests/coinbase.test.ts` (no `-A`). Report SHA. Leave dev stopped.

## After it lands — the read
Restart and watch ~30s of logs. Success = **no repeating `coinbase_disconnected`** (or only the rare
normal one), and the firehose now carries Coinbase-active symbols (LINK/ATOM/DOT) at multiple
ticks/sec. If it still drops, the new `code`/`reason` on `coinbase_disconnected` tells us exactly why
(e.g., 1006 abnormal vs a policy message) and we fix that specifically.
