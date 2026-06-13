# Neonfi backend — Stage 10B: Client-facing WebSocket server (ticket auth + fan-out + plan downgrade)

This file is the source-of-truth intent for Stage 10B. Build from this; report back to Idowu when done. This completes the live-prices pipeline — Stage 10A built the upstream Coinbase + Redis cache + pub/sub publishing; Stage 10B builds the downstream client-facing surface that consumes pub/sub and fans out to authenticated sockets.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 10A landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` (for the ticket issuance pattern), `_claude/stage-1b.md` (for `GET /auth/ws-token` which writes `ws_ticket:<token>` to Redis — Stage 10B consumes that exact key shape), `_claude/stage-4a.md` (for the webhook handlers Stage 10B extends to publish plan-change events), `_claude/stage-10a.md` (Coinbase client + Redis `price:<SYMBOL>` channels + WS-health stub — Stage 10B finishes the latter and consumes the former).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **§2.7 WebSocket & Redis pub/sub contract IN FULL** (this is the contract spec; every message envelope, close code, and divergence watch is non-negotiable), **§6.4 Realtime layer** (the resilience + delivery-guarantee invariants), **§4.5 Real-time price flow (Pro)** (the end-to-end happy path).
3. `Neonfi System Architecture.docx` — **WEBSOCKET section** (envelopes + close codes + ticket flow), **Real-Time Conventions**, **Price Module** (the reference-counted subscription rule).
4. `src/lib/ws.ts` (frontend repo `C:\Users\pelum\Desktop\Neonfi\src\lib\ws.ts`) — the CONSUMER side. Read this file line by line. The exact keys it reads (`msg.payload.symbol`, `msg.payload.price`, `msg.payload.change24h`, `msg.type === 'price_update' | 'reconnect' | 'plan_downgraded' | 'error'`) are the contract you must produce.
5. `src/ws/server.ts` and `src/ws/registry.ts` (this repo) — Stage 1A placeholders. 10B fills them in.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Use raw `ws` library on a dedicated upgrade-event handler — NOT Hono WS adapter [LOCKED]

Hono has `@hono/node-ws` for WebSocket integration via the router. **Don't use it.** The WS endpoint at `/ws` needs ticket validation BEFORE the upgrade completes, plan check BEFORE the upgrade completes, and access to the underlying `WebSocketServer` object for sending messages — things that are cleaner with a raw `ws.WebSocketServer` attached to the existing Node HTTP server's `upgrade` event.

Pattern (similar to how Stage 10A uses `ws` client-side):

```ts
// src/ws/server.ts
import { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'node:http';

let _wss: WebSocketServer | null = null;

export function startWsServer(httpServer: HttpServer): void {
  if (_wss) return; // idempotent
  _wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', async (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws') return;
    // ticket + plan validation BEFORE handleUpgrade
    const result = await authorizeUpgrade(req);
    if (!result.ok) {
      socket.write(`HTTP/1.1 ${result.status} ${result.statusText}\r\n\r\n`);
      socket.destroy();
      return;
    }
    _wss!.handleUpgrade(req, socket, head, (ws) => {
      _wss!.emit('connection', ws, req, result.context);
    });
  });
  _wss.on('connection', handleConnection);
}

export function isWsServerRunning(): boolean { return _wss !== null; }
```

`isWsServerRunning()` is the cheap probe `GET /ws/health` reads (combined with the Coinbase check from Stage 10A).

Like Stage 10A's coinbase boot, gate the server start: `src/index.ts` calls `startWsServer(httpServerHandle)` after `serve()` only if `NODE_ENV !== 'test'`. The HTTP server handle is obtained from `serve()`'s return value (`@hono/node-server` exposes the underlying Node server).

### 1.2 Ticket validation at upgrade — GETDEL the Stage 1B Redis key [LOCKED]

Stage 1B's `GET /auth/ws-token` writes `ws_ticket:<token>` → `<userId>:<sessionId>` with 60s TTL. Stage 10B's upgrade handler:

1. Parse `?token=<ticket>` from `req.url`. Missing → HTTP 401.
2. `await redis.getdel('ws_ticket:' + token)`. Returns null if absent/expired/already-consumed → **HTTP close code 4001**.

   Wait — there's a subtlety. The Build Guide §2.7 says "Close codes: `4001` invalid/expired/consumed ticket." But the upgrade isn't a WebSocket yet at this point; you can't send a WebSocket close code before the upgrade completes. Two options:
   - (a) Return HTTP 401 at the upgrade level. The client sees connection refused, not a WebSocket close.
   - (b) Complete the upgrade unconditionally, then immediately send a close with 4001.

   **Pick (a)** — HTTP 401 at upgrade rejection. The Build Guide's "4001" applies to the case where the upgrade succeeded but the ticket was consumed mid-session (e.g., the ticket-consumed-too-late race). Document this in a code comment so the contract spec is traceable.
3. Parse `<userId>:<sessionId>` from the redis value. Load the user via `findUserById(userId)`. Load the session via `findSessionById(sessionId)`. If session is `revokedAt !== null` or `expiresAt < now` → HTTP 401.
4. Plan check via `getEffectivePlan(userId)`. Free → **HTTP 403** (per Build Guide §2.7 "Free users are rejected at handshake (403)"). Pro → proceed.
5. Pass the `{ userId, sessionId, plan }` context through to the connection handler.

### 1.3 Connection state — per-socket symbol set + per-user socket map [LOCKED]

Each connected WebSocket gets a unique `socketId` (use `crypto.randomUUID()` — short, collision-safe). The server maintains TWO in-memory maps (single-process at MVP, no cross-process sharing needed):

```ts
const socketsByUser = new Map<number, Set<string>>();  // userId → socketIds
const wsBySocketId = new Map<string, WebSocket>();      // socketId → ws
```

Plus the per-symbol Redis SET (`subs:<SYMBOL>` per Build Guide §6.4):
- On `subscribe` message: `redis.sadd('subs:' + SYMBOL, socketId)`. If `redis.scard('subs:' + SYMBOL)` was 0 before the add (use `SADD` return value: 1 = was new, 0 = was duplicate; combined with a prior `SCARD` it works, but the cleanest is `SADD` + check the return), call `coinbase.subscribeToSymbol(SYMBOL)`.
- On close: for every SYMBOL the socket was subscribed to, `redis.srem('subs:' + SYMBOL, socketId)`. If `redis.scard('subs:' + SYMBOL)` is 0 after the rem, call `coinbase.unsubscribeFromSymbol(SYMBOL)`.

**Critical**: the Coinbase reference-count (from Stage 10A) is independent of the `subs:<SYMBOL>` SET refcount. They happen to track related things but at different levels. Stage 10A's Map is "how many distinct subscribers in this process want this symbol from Coinbase"; the Redis SET is "which sockets in this process want fan-out for this symbol." At MVP (single process), they're isomorphic. Don't merge them — they diverge once horizontal scaling lands (Redis becomes the cross-process source of truth).

The server tracks each socket's subscribed symbols separately (a per-socket `Set<string>` stored on the WebSocket object, or in a Map keyed by socketId) so cleanup-on-close knows which symbols to SREM.

### 1.4 Subscribe + price_update envelope [LOCKED — frontend reads exact keys]

**Client → server `subscribe`** (per Build Guide §2.7):
```json
{ "type": "subscribe", "payload": { "symbols": ["BTC", "ETH"] } }
```

Server handler:
1. Parse JSON. Bad → send `error` envelope (payload describing the error), don't disconnect.
2. Validate `payload.symbols` is an array of strings, each matching a Token in the DB. Unknown symbols → send `error` with `payload: { invalid: [<bad symbols>] }`, continue with the valid ones.
3. For each valid symbol: register in `subs:<SYMBOL>` Redis SET, register on the per-socket symbol set, and (if first subscriber for this symbol per §1.3) call `coinbase.subscribeToSymbol(symbol)`.
4. Do NOT respond with an ack — the frontend doesn't expect one. The next `price_update` for those symbols IS the implicit ack.

**Server → client `price_update`** (per Build Guide §2.7, divergence watch is exact):
```json
{ "type": "price_update", "payload": { "symbol": "BTC", "price": 93061.53, "change24h": 1.88 }, "timestamp": "<ISO 8601>" }
```

The fields are nested INSIDE `payload`; `timestamp` is a SIBLING of `type` and `payload`. The frontend reads `msg.payload.symbol` and `msg.payload.price` (`lib/ws.ts:51-52`). A flat `{ type, symbol, price }` would silently no-op the consumer — that's the Build Guide §2.7 divergence-watch warning.

### 1.5 Fan-out from Redis pub/sub [LOCKED]

Stage 10A's Coinbase client publishes price updates to Redis channel `price:<SYMBOL>` per Stage 10A §1.3. Stage 10B's WS server subscribes to those channels. Each incoming pub/sub message is fanned out to sockets in the matching `subs:<SYMBOL>` SET.

**Redis SUBSCRIBE requires a dedicated client.** Can't share with the main `redis` client (which is busy with queries). Create a second singleton:

```ts
// src/lib/redis-subscriber.ts
import Redis from 'ioredis';
import { config } from './config.js';

export const redisSubscriber = new Redis(config.REDIS_URL);
```

Add `Redis` (or whichever ioredis class name) to `scripts/check-singletons.mjs`'s guard list — but since BOTH `redis.ts` and `redis-subscriber.ts` legitimately construct one, exclude the `src/lib/` directory from the guard (which it already is).

Pattern: subscribe to a channel ONLY when at least one socket has subscribed to the symbol; unsubscribe when the last socket goes away. Track via an in-memory `Set<string>` of currently-subscribed channels in the WS server.

```ts
// pseudocode
async function ensureRedisChannelSubscribed(symbol: string): Promise<void> {
  if (subscribedRedisChannels.has(symbol)) return;
  await redisSubscriber.subscribe('price:' + symbol);
  subscribedRedisChannels.add(symbol);
}

async function ensureRedisChannelUnsubscribed(symbol: string): Promise<void> {
  if (!subscribedRedisChannels.has(symbol)) return;
  await redisSubscriber.unsubscribe('price:' + symbol);
  subscribedRedisChannels.delete(symbol);
}
```

On message: parse channel name → symbol, parse payload, look up `subs:<symbol>` SET members, send the price_update envelope to each socket in `wsBySocketId`.

### 1.6 Plan downgrade mid-session — extend Stage 4A webhook handlers to publish [LOCKED]

Build Guide §2.7: "Pro user's subscription expires during an active WebSocket session → server sends `plan_downgraded` event and closes the connection with a `4003` close code."

The detection mechanism is cross-module: Stage 4A's webhook handlers (`handleCustomerSubscriptionUpdated`, `handleCustomerSubscriptionDeleted`) update Subscription state in the DB. Stage 10B's WS server needs to know when that happens for users who are currently connected.

**Approach: Stage 4A publishes a Redis pub/sub event on plan/status change.** Stage 10B's WS server subscribes to that channel.

Extend Stage 4A's handlers to publish, AFTER the DB commit:
```ts
// In src/modules/webhooks/stripe-handlers.ts, in handleCustomerSubscriptionUpdated and handleCustomerSubscriptionDeleted:
await redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: subscription.userId }));
```

This is a small, surgical edit to two functions, each a single new line. Don't introduce a new channel per user — single `user_events` channel, payload includes userId. The WS server filters in-process.

In Stage 10B's WS server:
```ts
await redisSubscriber.subscribe('user_events');
redisSubscriber.on('message', async (channel, raw) => {
  if (channel === 'user_events') {
    const evt = JSON.parse(raw);
    if (evt.type === 'plan_changed') {
      const newPlan = await getEffectivePlan(evt.userId);
      if (newPlan === 'free') {
        // Send plan_downgraded + close 4003 for every socket of this user
        const socketIds = socketsByUser.get(evt.userId) ?? new Set();
        for (const sid of socketIds) {
          const ws = wsBySocketId.get(sid);
          if (!ws) continue;
          ws.send(JSON.stringify({ type: 'plan_downgraded', payload: { message: 'Your Pro subscription has expired' }, timestamp: new Date().toISOString() }));
          ws.close(4003, 'Plan downgraded');
        }
      }
    }
  } else if (channel.startsWith('price:')) {
    // fan-out logic from §1.5
  }
});
```

The `price:*` and `user_events` channels share the same subscriber connection. ioredis handles dispatch by channel name in the `on('message', ...)` callback.

### 1.7 `GET /ws/health` finally returns the real state [LOCKED]

Stage 10A's `/ws/health` checked Coinbase and stubbed `clientWs: 'up'`. Stage 10B's WS server fills that in. Update `src/ws/health.ts` (created in Stage 10A):

```ts
import { coinbase } from '../lib/coinbase.js';
import { isWsServerRunning } from './server.js';

export function wsHealthHandler(c) {
  const coinbaseUp = coinbase.isConnected();
  const wsServerUp = isWsServerRunning();
  if (coinbaseUp && wsServerUp) {
    return c.json({ status: 'ok' }, 200);
  }
  return c.json({ status: 'degraded', services: { coinbase: coinbaseUp ? 'up' : 'down', clientWs: wsServerUp ? 'up' : 'down' } }, 503);
}
```

When `NODE_ENV === 'test'` and the WS server isn't started, `isWsServerRunning()` returns false → `/ws/health` returns 503. Tests that check `/ws/health` need to mock `isWsServerRunning` (like Stage 10A's tests already mock `coinbase.isConnected`).

### 1.8 `reconnect` envelope from Coinbase resilience [LOCKED]

Per Build Guide §6.4 the Coinbase client (Stage 10A) sends a `reconnect` message to all connected clients during a Coinbase-side reconnect. The Coinbase client emits the reconnect event; the WS server fans it out.

Add a small event hook to the Stage 10A Coinbase client: when `_scheduleReconnect()` is called, publish `{ type: 'reconnect', payload: { retryAfterMs: <backoff>, reason: 'coinbase_reconnecting' } }` to Redis channel `client_events` (single fan-out channel). Stage 10B's WS server subscribes to `client_events` and sends the envelope to ALL connected sockets (not just symbol-subscribed ones — this is a connection-wide event).

If touching the Stage 10A Coinbase client feels invasive, an alternative is to have the WS server poll `coinbase.isConnected()` and infer reconnect state from transitions. That's flakier. Prefer the event-emitter approach.

### 1.9 Error envelope [LOCKED]

When the server needs to send an error to a single socket (bad subscribe message, unknown symbols, etc.), use:

```json
{ "type": "error", "payload": { "code": "INVALID_SUBSCRIBE_MESSAGE", "message": "..." }, "timestamp": "<ISO>" }
```

Don't close the connection on error — the client can recover (e.g., resend a corrected subscribe). Only close for ticket failures (handled at upgrade time) and plan downgrade.

## 2. Module scope

```
src/ws/server.ts                          # EDIT — replace placeholder with full WS server
src/ws/registry.ts                        # EDIT — symbol-set helpers + per-socket cleanup
src/ws/health.ts                          # EDIT — read real isWsServerRunning() state
src/lib/redis-subscriber.ts               # NEW — second ioredis singleton for SUBSCRIBE
src/lib/coinbase.ts                       # EDIT — publish reconnect events to client_events Redis channel
src/modules/webhooks/stripe-handlers.ts   # EDIT — publish plan_changed to user_events Redis channel in 2 handlers
src/index.ts                              # EDIT — call startWsServer(server) after serve(), gated by NODE_ENV !== 'test'
scripts/check-singletons.mjs              # NO EDIT — guard list unchanged; src/lib/redis-subscriber.ts is inside src/lib/
tests/ws.test.ts                          # NEW — ~18 tests
tests/health.test.ts                      # EDIT — extend to verify clientWs check (mock isWsServerRunning)
```

Do NOT touch any other module directory. The webhook handler edit is the only outside-of-`src/ws/` change.

## 3. Endpoints / WS surface

### 3.1 `WSS /ws?token=<ticket>` — client-facing WebSocket [LOCKED]

- Upgrade-level auth per §1.2 (401 missing/expired ticket, 403 free user).
- After successful upgrade: client sends `subscribe` messages, server fans out `price_update` messages.
- Server may send `error`, `reconnect`, `plan_downgraded` envelopes anytime.
- Close codes: 4001 (consumed-mid-session ticket — rare race), 4003 (plan downgrade), 1000 (normal close).
- No subscribe → no fan-out. The server doesn't push prices for symbols the client hasn't subscribed to.

### 3.2 `GET /ws/health` — finally accurate [LOCKED per §1.7]

200 only when both Coinbase AND WS server are up; 503 with which-is-down detail otherwise.

## 4. Cross-cutting wiring

### 4.1 Subscriber singleton

`src/lib/redis-subscriber.ts` per §1.5. Don't reuse `src/lib/redis.ts` — pub/sub SUBSCRIBE locks the connection out of normal commands.

### 4.2 HTTP server hook

The `@hono/node-server` `serve()` returns a Node HTTP server. Capture the return:

```ts
// src/index.ts (existing)
const server = serve({ fetch: app.fetch, port: 3000 }, (info) => { ... });
if (config.NODE_ENV !== 'test') {
  coinbase.connect();
  startTokenSyncScheduler();
  startWsServer(server);
}
```

### 4.3 Webhook handler edits (small, surgical)

In `src/modules/webhooks/stripe-handlers.ts`:

```ts
// In handleCustomerSubscriptionUpdated, AFTER the prisma.subscription.update commit:
await redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: localSub.userId }));

// In handleCustomerSubscriptionDeleted, AFTER the DB writes commit:
await redis.publish('user_events', JSON.stringify({ type: 'plan_changed', userId: localSub.userId }));
```

These are two single-line additions. Don't refactor the surrounding code.

### 4.4 Coinbase client reconnect event

In `src/lib/coinbase.ts`, modify `_scheduleReconnect()` to publish a Redis event:

```ts
await redis.publish('client_events', JSON.stringify({
  type: 'reconnect',
  payload: { retryAfterMs: delay, reason: 'coinbase_reconnecting' }
}));
```

Stage 10A's tests for the Coinbase client should still pass — the new line is an additional side effect, not a behavior change for any existing assertion.

## 5. Tests (Vitest, integration — new file `tests/ws.test.ts`)

Test numbering continues from Stage 10A (~250).

**Test strategy**: real WS server started in `beforeAll` via `startWsServer(testHttpServer)`. Real WS clients via the `ws` library connect to it. Coinbase client is MOCKED (we don't want real Coinbase calls); same mock pattern as Stage 10A's coinbase.test.ts. Redis is REAL (pub/sub needs real semantics; mocking ioredis pubsub is fiddly).

Setup helper:
```ts
import { WebSocket } from 'ws';
let testServer: HttpServer;
let testUrl: string;

beforeAll(async () => {
  testServer = createServer();
  startWsServer(testServer);
  await new Promise<void>((r) => testServer.listen(0, '127.0.0.1', () => r()));
  const { port } = testServer.address() as AddressInfo;
  testUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  // close server, close subscriber, etc.
});
```

Tests issue valid + invalid tickets (write/read Redis directly), connect with `new WebSocket(testUrl + '?token=' + ticket)`, send subscribe messages, and assert the messages they receive back.

### Handshake — 6 tests

251. **Valid Pro ticket → connection opens** → `ws.on('open')` fires; HTTP upgrade returns 101.
252. **Missing token query param → 401** (HTTP error, not WS close).
253. **Invalid ticket (random string) → 401**.
254. **Expired ticket (TTL passed) → 401**.
255. **Consumed ticket (used once already) → 401**.
256. **Free user ticket → 403**.

### Subscribe + fan-out — 6 tests

257. **Subscribe to BTC → coinbase.subscribeToSymbol called once for BTC**.
258. **Second socket subscribes to same BTC → coinbase.subscribeToSymbol NOT called again** (refcount holds it).
259. **Publish `price:BTC` to Redis → both subscribers receive `price_update` envelope** with exactly `{ type: 'price_update', payload: { symbol, price, change24h }, timestamp }`.
260. **Publish `price:ETH` (no subscribers) → no socket receives anything**.
261. **Disconnect socket → `subs:BTC` Redis SET no longer contains its socketId**.
262. **Last subscriber disconnects → coinbase.unsubscribeFromSymbol called for BTC**.

### Error envelope — 2 tests

263. **Malformed subscribe message (not JSON) → server sends `error` envelope; connection stays open**.
264. **Subscribe to unknown symbol → server sends `error` with `payload.invalid: ['XYZ']`; valid symbols in same call still subscribed**.

### Plan downgrade — 2 tests

265. **Publish `user_events` plan_changed for connected Pro user → user gets `plan_downgraded` envelope + close 4003**. Mock `getEffectivePlan` to return 'free'.
266. **plan_changed event for user not connected → no-op (no errors logged)**.

### Reconnect envelope — 1 test

267. **Publish `client_events` reconnect → all connected sockets receive `reconnect` envelope** with `payload.retryAfterMs` set.

### Health — 1 test (extends Stage 10A's health.test.ts)

Update test 249/250 to mock `isWsServerRunning()` instead of stubbing `clientWs: 'up'` unconditionally:

268. **GET /ws/health when WS server NOT running → 503 with clientWs: 'down'**.

Total new tests: 18. After Stage 10B: ~268.

## 6. STOP-AND-ASK gates

1. **If `@hono/node-server`'s `serve()` return doesn't expose the underlying HTTP server**, STOP. The architecture depends on attaching to its `upgrade` event. Surface the version issue.
2. **If the `ws` library's `WebSocketServer({ noServer: true }) + handleUpgrade` pattern doesn't behave as expected** (e.g., upgrade event timing race), STOP and report. There are quirks across `ws` versions.
3. **If existing 250 tests fail after the `client_events` reconnect publish is added to Stage 10A's coinbase.ts**, STOP. The publish is a no-op when Redis is mocked, but if the coinbase test's mock doesn't tolerate the new call, it needs extending.
4. **If a WS test deadlocks** (waiting forever for a `price_update` that never arrives), check that the test is publishing to the correct channel — `price:BTC` (uppercase symbol after the colon), not `price:btc`.

## 7. What NOT to do

- **No WS server start during tests via the global hook.** Tests explicitly start a fresh server on an ephemeral port; the global gate keeps the production server out of test runs.
- **No flat `{type, symbol, price}` envelopes.** Always nested per §1.4.
- **No HTTP 4xx response shape for WS upgrade failures.** 401/403 only, plain text body or empty body — the upgrade isn't an `/api/v1/*` route.
- **No `meta` field on WS messages.** Envelope is `{ type, payload, timestamp }` strictly.
- **No subscriber-side ack messages.** Client sends `subscribe`, server starts fanning out — that's the protocol.
- **No reading the Stage 1A `prices_session` Redis prefix or anything outside the documented keys.** `ws_ticket:*`, `subs:*`, `price:*`, `user_events`, `client_events` are the full surface.
- **No mocking Redis pub/sub in tests.** Real Redis. The publish/subscribe semantics are too fragile to fake.
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(ws): Stage 10B — client-facing WS server + ticket auth + symbol fan-out + plan downgrade + reconnect propagation"
git log --oneline -5
```

Report:
- New commit SHA.
- One sample of each envelope type from a test capture: `subscribe` (client → server), `price_update` (server → client), `error`, `reconnect`, `plan_downgraded`.
- Vitest output: all tests passing (count ~268).
- Confirmation `/ws/health` returns 503 when `isWsServerRunning()` is false (tests cover both branches).
- Confirmation `coinbase.subscribeToSymbol/unsubscribeFromSymbol` are called exactly once per Coinbase round-trip (refcount works).
- Confirmation Stage 4A's webhook handlers now publish `user_events` and don't otherwise change behavior (the existing webhook tests should still pass).
- Doc-fix pile items added in Stage 10B:
  - `Neonfi System Architecture.docx` WebSocket section: clarify that ticket failures at the UPGRADE level return HTTP 401, while in-session ticket invalidation closes with 4001 (the Build Guide pseudocodes them together).
  - `Neonfi System Architecture.docx` Real-Time Conventions: the cross-module `user_events` channel is an implementation detail that the architecture should acknowledge as the canonical plan-change signal between webhook and WS server.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
