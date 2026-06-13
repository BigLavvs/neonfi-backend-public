# Neonfi backend — Stage 10A: Price layer (Coinbase WS upstream + Redis cache + REST refresh + /ws/health)

This file is the source-of-truth intent for Stage 10A. Build from this; report back to Idowu when done. Stage 10B (client-facing WS server + ticket consumption + fan-out) is a separate prompt that builds ON TOP of 10A's Coinbase client + Redis cache.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 9B landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-9b.md` (this repo). Stage 10A reuses every prior pattern; especially relevant: the scheduler+sync split from Stage 9B (a similar long-running background piece in src/jobs/ or src/lib/), the singleton-client pattern (Stage 1A's Prisma/Redis singletons; Coinbase becomes the third), the `{ timeout: 15000 }` and lookups-outside-transaction pattern, the FK-cascade-from-Portfolio cleanup pattern.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 10 in §3 in full**, **§2.5 Caching** (60s TTL on prices, no DB reads for prices), **§6.4 Realtime layer** (the cross-cutting WS contracts — only the Coinbase-resilience part matters for 10A), **§6.8 Observability** (the Coinbase connection health monitoring + structured logging requirements).
3. `Neonfi System Architecture.docx` — **WebSocket section** (Coinbase WS notes, the 30-second ping + 5-second pong + 1/2/4/8/16/30 backoff sequence), **Connection Resilience** rules, **Price Module** rules.
4. `Neonfi System Implementation.docx` §11 — service resilience (the `GET /ws/health` 200/503 contract).
5. `src/lib/coinbase.ts` — Stage 1A placeholder. 10A fills it in as the Coinbase WS client singleton.
6. `src/lib/health.ts` — Stage 1A built the DB+Redis probe. 10A folds the Coinbase WS liveness in per the TODO marker Stage 4A left.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Coinbase WS client = singleton, started at app boot [LOCKED]

Per Build Guide §6.4: "One shared persistent connection; health ping every 30s; dead if no pong within 5s; reconnect with exponential backoff 1s→2s→4s→8s→16s, cap 30s; alert engineering after 5 failed attempts; notify clients via reconnect message."

The Coinbase client is the third singleton in the codebase (after Prisma + Redis). `src/lib/coinbase.ts` exports the singleton. Same singleton-guard pattern as Prisma/Redis — `scripts/check-singletons.mjs` already excludes `src/lib/`, just add `Coinbase` to the constructor-name guard list.

Connection lifecycle (one persistent WS to `COINBASE_WS_URL`):
- App boot (NOT in tests; gate via NODE_ENV like Stage 9B's scheduler): construct client, open connection, register listeners.
- On `open`: log structured event, set state=connected, schedule the 30s ping.
- On message: route via switch on message type — heartbeat ack updates lastPong timestamp; `ticker` message writes the price to Redis (per §1.3 below) and publishes on the pub/sub channel.
- On `close` / `error`: log, transition to reconnecting, start exponential backoff per the documented sequence. After 5 failed attempts, log `coinbase_reconnect_alert` (Build Guide §6.4 — alert routing is operator-config, not a code path).
- Ping/pong supervisor: every 30s send a ping; if 5s elapses without a pong, treat as dead → forcibly close → reconnect loop kicks in.

Use `ws` (npm: `ws`) as the WebSocket client library. Already widely used in Node; tiny; no Coinbase-specific SDK needed — Coinbase's WS is just standard JSON-over-WS.

### 1.2 Don't subscribe to symbols at boot — that's Stage 10B's job [LOCKED]

The Coinbase WS connection is OPEN at boot but NOT subscribed to any symbols. Stage 10B's client-facing WS server is what triggers subscriptions when actual users connect and ask for symbols. The Coinbase client EXPOSES methods:

```ts
class CoinbaseClient {
  // Maintain a refcount-keyed map: symbol → number of subscribers.
  // First subscriber for a symbol → send Coinbase subscribe message.
  // Last subscriber unsubscribes → send Coinbase unsubscribe message.
  async subscribeToSymbol(symbol: string): Promise<void>;
  async unsubscribeFromSymbol(symbol: string): Promise<void>;
  isConnected(): boolean;
  // For tests: bypass the real WS — inject a mock 'ws' Server.
}
```

Reference-counting prevents the bug Build Guide §Stage 10 calls out: "many clients watching the same symbol (BTC, ETH) must result in ONE Coinbase subscription, not one per client." The refcount is in-memory inside the singleton (Coinbase client is single-process; no cross-process coordination needed at MVP).

Stage 10A builds the refcount-aware subscribe/unsubscribe methods + the actual WS protocol calls. Stage 10B calls them.

### 1.3 Redis price cache — `price:<symbol>` keys, 60s TTL [LOCKED by Build Guide §2.5]

Every ticker message Coinbase sends updates two Redis keys:
- `price:<SYMBOL>` (string value, JSON-encoded `{ price, change24h, timestamp }`), TTL 60s
- Pub/sub publish on channel `price:<SYMBOL>` with the same payload

The TTL is a freshness floor: if Coinbase is down for >60s, the cache expires and free-user reads get a miss → falls back to the DB `Token.currentPrice` (refreshed every 6 hours by Stage 9B).

Pub/sub channel naming: `price:<SYMBOL>` (uppercase symbol). Stage 10B subscribes to these channels for client fan-out.

`SYMBOL` is the canonical uppercase symbol (BTC, ETH, etc.) — matches the Token table's symbol column.

### 1.4 `POST /prices/refresh` — free-user manual refresh, rate-limited [LOCKED]

Per Build Guide §Stage 10: free users have no WS connection; they use `POST /prices/refresh` to fetch the latest prices on-demand. Pro users use the WS instead.

Request body: optionally `{ symbols: string[] }` to limit; if omitted, refresh every symbol in the user's portfolios' assets (via `prisma.asset.findMany`). Practical limit: max 50 symbols per call (Zod).

**Plan check:** free users only. Pro users → `403 PRO_USES_WEBSOCKET`. Use the new `requirePlan(['free'])` form of the middleware. Stage 5's free-tier definition (no subscription → free) applies; mid-onboarding users get refresh access.

**Rate limit:** per Build Guide §6.9, rate-limit `POST /prices/refresh` so free users can't spam it. Use Redis key `refresh_rate:<userId>` with TTL 30 seconds (so one refresh allowed every 30s per user). On second call within window: `429 TOO_MANY_REQUESTS` with `meta: { retryAfterMs }`.

**Flow:**
1. Validate body (Zod).
2. Plan check (free only).
3. Rate-limit check (Redis SET NX with EX 30 on the user's key).
4. Determine symbols: from body OR from user's portfolios' assets.
5. For each symbol: read `price:<SYMBOL>` from Redis. Miss → fall back to DB `Token.currentPrice`. (No upstream fetch — that's Coinbase's job; free users wait for the cache to refresh from Coinbase ticker events.)
6. Respond: `200 { data: { prices: [ { symbol, price, change24h, source: 'cache' | 'db' } ] } }`.

The endpoint doesn't actually CALL anything upstream — it just returns whatever Redis/DB has. This is intentional: rate-limiting + free-tier-only means Stage 9B's 6-hour CMC sync is the freshest free users get, and that's by design (the upgrade nudge is "Pro = live prices via WS").

Wait — that means the "refresh" button doesn't actually refresh? Just returns cached values. That's misleading UX.

Alternative interpretation: `POST /prices/refresh` actually triggers a CMC fetch for the requested symbols, writes to Redis, returns the fresh prices. This makes the button meaningful — the user clicked it, the values are updated.

**Decision: triggers a CMC fetch for the symbols, caps at 5 symbols per call, writes to Redis cache.** Rate-limit becomes the cost guard (one CMC call per 30s per user, max 5 symbols per call → 10 symbols/minute per user at peak → easily within CMC free tier even with many users).

Update the flow:
1. Validate body. Default symbols = first 5 symbols from user's portfolios' assets, sorted by addedAt or by token rank.
2. Plan check + rate-limit.
3. Resolve symbols (capped at 5).
4. Call CMC adapter (the same one Stage 9B uses — extend `CoinMarketCapTokenMetadataProvider` to expose `fetchPrices(symbols)` if Stage 9B hasn't already). On success: write each price to `price:<SYMBOL>` Redis key with 60s TTL.
5. Respond with the freshly-fetched prices + `source: 'live'`.

If CMC errors: degrade to cache+DB fallback, surface a `partialFailure: true` flag in the response.

This makes the refresh button do something real while respecting cost. Stage 9B's CMC adapter becomes load-bearing for both background sync AND user-driven refresh.

### 1.5 `GET /ws/health` — 200 only when Coinbase WS is connected [LOCKED]

Per Build Guide §6.4: "GET /ws/health returns 200 only when both the client-facing WS server AND the Coinbase connection are up, else 503."

Stage 10A returns 200 if Coinbase WS is connected; 503 otherwise. The client-facing WS server part is Stage 10B — for 10A, treat it as "always up" (since 10A doesn't build the client-facing server yet). When 10B lands, it'll AND its own state in.

Response shape: `200 { data: { status: 'ok', coinbase: 'up', clientWs: 'up' } }` or `503 { error: { code: 'WS_HEALTH_FAILED', message: 'Coinbase WS down' } }`.

Coolify polls this; on two consecutive failures it restarts the container per the Service Resilience config (System_Implementation §11). On restart, the Coinbase client reconnects from scratch.

### 1.6 Fold Coinbase liveness into `/health` [LOCKED — finishing the Stage 4A TODO]

The `/health` endpoint (Stage 1A) currently checks DB + Redis. The Stage 4A TODO comment at the bottom of `src/lib/health.ts` says "fold Coinbase WS liveness into this probe per System_Implementation §2 / Build Guide §6.8 — currently DB+Redis only." Stage 10A does this.

The check is "Coinbase client reports connected" — not a network round-trip, just a state read from the singleton. On disconnect, `/health` 503s and Coolify restarts the container if the failure persists. Same restart triggers a fresh Coinbase reconnect, so the restart is the recovery.

Remove the Stage 4A TODO comment from `src/lib/health.ts` once the Coinbase check is wired in.

### 1.7 New env vars [LOCKED]

`COINBASE_WS_URL` already exists in `.env.example` (Stage 1A added it as required). No new env vars.

Stage 9B's CMC integration (which 10A now formalizes) needs `COINMARKETCAP_API_KEY` to actually function. If you wire `/prices/refresh` to call CMC, the key becomes required at request time but stays OPTIONAL at boot (graceful degradation: no key → endpoint returns cache+DB fallback only with `source: 'db'`).

### 1.8 Connection resilience constants [LOCKED by Build Guide §6.4]

Lock these as constants in `src/lib/coinbase.ts` rather than env vars — Build Guide pins them:

- `PING_INTERVAL_MS = 30_000`
- `PONG_TIMEOUT_MS = 5_000`
- `RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]` then cap at `30_000`
- `RECONNECT_ALERT_AFTER_ATTEMPTS = 5`

Document with a code comment referencing Build Guide §6.4 so future tweaks are clearly architectural decisions, not magic numbers.

## 2. Module scope

```
src/lib/coinbase.ts                      # EDIT — replace placeholder with the singleton WS client
src/lib/health.ts                        # EDIT — add Coinbase check; remove Stage 4A TODO
src/modules/prices/prices.controller.ts  # NEW — POST /prices/refresh
src/modules/prices/prices.service.ts     # NEW — refresh logic, cache reads, CMC integration
src/modules/prices/prices.schemas.ts     # NEW — Zod for refresh body
src/modules/tokens/sync/sync.ts          # EDIT — surface a fetchPrices() helper for the prices module to reuse (or extract into a shared cmc-client)
src/modules/tokens/sync/moralis-provider.ts  # RENAME → coinmarketcap-provider.ts + actual CMC HTTP implementation
src/jobs/token-sync.job.ts               # NO EDIT — already calls runTokenMetadataSync which now uses CMC
src/ws/health.ts                         # NEW — small helper exporting the Coinbase + clientWs state checks
src/app.ts                               # EDIT — mount /api/v1/prices + GET /ws/health
src/index.ts                             # EDIT — start the Coinbase client at boot (gated by NODE_ENV !== 'test')
scripts/check-singletons.mjs             # EDIT — add `new CoinbaseClient` to the guard list
package.json                             # EDIT — add `ws` (already a dep transitively via Hono? verify) + `@types/ws`
tests/prices.test.ts                     # NEW — ~10 tests
tests/coinbase.test.ts                   # NEW — ~6 tests against a mock WS server
tests/health.test.ts (maybe existing)    # EDIT or NEW — verify /health and /ws/health reflect Coinbase state
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `POST /prices/refresh` — manual refresh (free users only)

**`requireAuth` + `requirePlan(['free'])` middleware required.** Body (Zod, optional):

```json
{ "symbols"?: string[]  // max 5, all uppercase, must match a Token in the user's portfolios }
```

If `symbols` is omitted: derive from the user's portfolios' assets (first 5 by addedAt asc).

**Flow per §1.4:**
1. Validate.
2. Plan check (free only — Pro users get `403 PRO_USES_WEBSOCKET`).
3. Rate-limit check (Redis SET NX with TTL 30s).
4. Determine the up-to-5 symbols.
5. Call CMC adapter (`fetchPrices(symbols)`). On success: write each to `price:<SYMBOL>` Redis with 60s TTL.
6. If CMC throws or returns partial: fall back to existing cache + DB per missing symbol.
7. Respond: `200 { data: { prices: [ { symbol, price, change24h, source: 'live'|'cache'|'db' } ], partialFailure?: boolean } }`.

### 3.2 `GET /ws/health` — Coinbase WS liveness check

**No auth** (Coolify polls this externally; treat like `/health`).

**Flow:**
1. Read Coinbase client's `isConnected()` state.
2. Read client-facing WS server state (always `'up'` for 10A; 10B will replace).
3. Both up → `200 { data: { status: 'ok', coinbase: 'up', clientWs: 'up' } }`.
4. Either down → `503 { error: { code: 'WS_HEALTH_FAILED', message: <which one is down> } }`.

Mount NOT under `/api/v1` (consistent with `/health` placement at app root).

## 4. Cross-cutting wiring

### 4.1 Install `ws`

`ws` is a Node.js standard for WebSocket clients/servers. Likely a transitive dep already (Hono's WS support uses it). Make it an explicit direct dep so the lockfile pins the version.

```bash
npm install ws
npm install --save-dev @types/ws
```

### 4.2 Coinbase client singleton

`src/lib/coinbase.ts` exports a single instance. Lazy initialization (don't construct at module load — `src/index.ts` explicitly calls `coinbase.connect()` after the Hono server is up).

```ts
class CoinbaseClient {
  private ws: WebSocket | null = null;
  private state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  private subscriptions: Map<string, number> = new Map();  // symbol → refcount
  private reconnectAttempts = 0;
  // ... lifecycle methods
}

export const coinbase = new CoinbaseClient();
```

`isConnected(): boolean { return this.state === 'connected'; }` is the cheap state probe `/health` and `/ws/health` use.

### 4.3 Mount price + health routes

In `src/app.ts`:

```ts
import { pricesRouter } from './modules/prices/prices.controller.js';
import { wsHealthHandler } from './ws/health.js';
// ...
api.route('/prices', pricesRouter);
app.get('/ws/health', wsHealthHandler);  // NOT under /api/v1
```

### 4.4 Boot the Coinbase client

In `src/index.ts`:

```ts
import { coinbase } from './lib/coinbase.js';
// ...after serve()
if (config.NODE_ENV !== 'test') {
  coinbase.connect();
}
```

### 4.5 Rename Stage 9B's adapter file

The placeholder `moralis-provider.ts` becomes `coinmarketcap-provider.ts` with real CMC HTTP implementation. Update the import in `sync.ts`. The class name changes: `CoinMarketCapTokenMetadataProvider`. The interface (`TokenMetadataProvider`) is unchanged — that's the whole point of the abstraction.

Add `fetchPrices(symbols): Promise<Map<symbol, { price, change24h }>>` as a method on the same class (not the interface — the interface is just for metadata sync; prices are a parallel concern). Or split into two interfaces if cleaner. Use your judgment.

### 4.6 CMC HTTP details

Endpoint: `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest`
Headers: `X-CMC_PRO_API_KEY: <COINMARKETCAP_API_KEY>`
Query: `?symbol=BTC,ETH,SOL,...` (comma-separated)

Response shape (simplified): `{ data: { BTC: [{ quote: { USD: { price: 93000.0, percent_change_24h: 1.5, market_cap: 1.85e12 } }, cmc_rank: 1 }] } }`.

Map this to `TokenMetadata` (for metadata sync) or `{ price, change24h }` (for price refresh). Handle the per-symbol array (CMC returns an array per symbol because the same ticker can have multiple listings; pick the first or the one with the highest market_cap).

If `COINMARKETCAP_API_KEY` is missing/empty: adapter returns empty Map + logs a warning. Doesn't crash. Sync becomes a no-op; refresh degrades to cache+DB.

### 4.7 Singleton guard

Update `scripts/check-singletons.mjs`:

```js
const SINGLETONS = ['PrismaClient', 'Redis', 'CoinbaseClient'];
```

Class name is `CoinbaseClient` (not `Coinbase` — distinct from the `coinbase` variable export).

## 5. Tests (Vitest, integration)

Test numbering continues from Stage 9B (~232).

### `tests/coinbase.test.ts` — 6 tests against a mock WS server

The mock: a tiny `ws.Server` that the test controls (uses `import { WebSocketServer } from 'ws'`), running on an ephemeral port. Inject a config override so `COINBASE_WS_URL` points at the test server for these tests.

233. **Connect successfully** → state transitions `disconnected → connecting → connected`; log line emitted.
234. **First subscribe message sends a Coinbase subscribe** → mock server sees the subscribe message; refcount = 1.
235. **Second subscribe to same symbol** → no second send (refcount = 2, dedup).
236. **First unsubscribe (refcount 2 → 1)** → no unsubscribe message sent.
237. **Last unsubscribe (refcount 1 → 0)** → unsubscribe message sent.
238. **Connection drop triggers reconnect with backoff** → mock server kills connection; client transitions to reconnecting; next attempt after 1s; etc.

### `tests/prices.test.ts` — 8 tests

Mock the CMC fetch (vi.mock the CMC adapter).

239. **POST /prices/refresh as free user with symbols=[BTC] (CMC returns price)** → 200, returns price with source='live'; Redis `price:BTC` set with TTL ~60.
240. **POST /prices/refresh as free user with no symbols (derive from portfolio)** → 200, uses first 5 of user's assets.
241. **POST /prices/refresh as pro user** → 403 `PRO_USES_WEBSOCKET`.
242. **POST /prices/refresh rate-limited (second call within 30s)** → 429 `TOO_MANY_REQUESTS`.
243. **POST /prices/refresh with symbols=[XYZ] (no Token row)** → 400 `VALIDATION_ERROR` or 404 `UNKNOWN_SYMBOL`.
244. **POST /prices/refresh when CMC throws** → 200 with `partialFailure: true`; sources are 'cache' or 'db' for the failing symbols.
245. **POST /prices/refresh with symbols.length=6** → 400 `VALIDATION_ERROR` (max 5).
246. **POST /prices/refresh no auth** → 401.

### Health updates — 4 tests

247. **GET /health with Coinbase up** → 200 includes coinbase: 'up'.
248. **GET /health with Coinbase down** → 503 with reason.
249. **GET /ws/health with Coinbase up** → 200 { coinbase: 'up', clientWs: 'up' }.
250. **GET /ws/health with Coinbase down** → 503.

Total new tests: 18. After Stage 10A: ~250.

For the Coinbase mock: the WebSocketServer pattern is well-documented; instantiate one in `beforeAll`, close in `afterAll`. The tests trigger client events by injecting messages from the server side.

## 6. STOP-AND-ASK gates

1. **If `ws` install conflicts with an existing version** (Hono pulls in a specific minor), surface the conflict and pick the higher minor. Don't downgrade Hono's transitive dep.
2. **If CMC's actual response shape differs from §4.6's example** (CMC API has evolved), adapt the parser. The test stubs use canned responses that match whatever shape Idowu confirms — don't over-engineer for fields you don't see.
3. **If the existing 232 tests fail after the Coinbase client adds to app boot**, STOP. The gate `NODE_ENV !== 'test'` should prevent the client from starting during tests; if it doesn't, the gate is wrong.
4. **If `/health` regressions appear** (existing tests assume DB+Redis only), update the test's expected shape — adding `coinbase: 'up'` is a documented contract extension, not a break.

## 7. What NOT to do

- **No client-facing WS server.** That's Stage 10B.
- **No ticket consumption.** Stage 10B.
- **No symbol-→-socketIds registry in Redis (`subs:<symbol>` SETs).** Stage 10B.
- **No `subscribe`/`price_update`/`reconnect`/`plan_downgraded` message handling on the client side.** Stage 10B owns the client-facing message envelopes.
- **No reading prices from the DB in 99% of paths.** The cache is the source. DB is fallback only on cache miss.
- **No Coinbase REST API.** Coinbase WS is the upstream; REST is for boot-up data we don't need here.
- **No CDN/HTTP caching headers on price responses.** Private authenticated data.
- **No removing the `MORALIS_API_KEY` env var.** Stage 11 (wallet sync) still uses it.
- **No retry inside the Coinbase ws.send call.** The reconnect supervisor handles connection failures; the send call just propagates.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(prices): Stage 10A — Coinbase WS client singleton + Redis cache + POST /prices/refresh + /ws/health + Coinbase folded into /health"
git log --oneline -5
```

Report:
- New commit SHA.
- The Coinbase client lifecycle log lines from a dev boot (or a test capture if dev boot isn't easy).
- One curl of `POST /prices/refresh` happy path.
- One curl of `GET /ws/health` and one of `GET /health` showing the new coinbase field.
- Vitest output: all tests passing (~250).
- Confirmation `coinbase.connect()` is gated by NODE_ENV !== 'test'.
- Confirmation `scripts/check-singletons.mjs` rejects any future `new CoinbaseClient` outside `src/lib/`.
- Doc-fix pile items added in Stage 10A:
  - `Neonfi System Architecture.docx` Appendix item 2: resolve to "CMC = token metadata vendor (sync + refresh); Moralis = wallet sync vendor (Stage 11)." Strike the "under evaluation" hedge.
  - `Neonfi System Implementation.docx` §11: add `GET /ws/health` and the Coinbase state to the `/health` shape.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
