# retrofit-16: multi-exchange price ingestion (Coinbase + Binance + Kraken)

Populate the canonical `price:<SYMBOL>` Redis cache for the whole catalog from **three** public
market-data WebSocket feeds, with cross-exchange symbol normalization and a freshness/priority
resolver. retrofit-15 (read overlay) consumes whatever this writes — keep them decoupled.

## Why three feeds
- **Coinbase** (already built, `lib/coinbase.ts`) — true USD pairs, but lists only a few hundred products.
- **Binance** — by far the widest catalog; one all-market stream covers everything at ~1 msg/sec.
  Geo-restricted by **server egress IP**, not by user — so the backend must be hosted in a
  Binance-reachable region (see Hosting). USDT-quoted (treat as ≈ USD).
- **Kraken** — true USD pairs; fills gaps and acts as a USD cross-check.

Per-symbol fallback: if a token has no fresh tick on one feed, the resolver uses the next.

## CRITICAL — verify exchange specs against current official docs before coding
The endpoints, stream names, and message schemas below are the intended design, **not** verified
current API facts. Exchange WS APIs change. Before implementing each client, confirm against the
official docs (and a quick manual `wscat`/script probe of the live stream) the current:
- WS URL, subscribe message format, and stream/channel name
- message field names for **last price** and **24h % change**
- pair/symbol naming (e.g. Binance `BTCUSDT`, Kraken historically `XBT` for BTC; Kraken WS v2
  may use normalized `BTC/USD`)
All three are **public market data** — no API key, no auth, no account. Do not add credentials.

## Plan

### 1. Per-exchange clients (mirror the Coinbase singleton)
Reuse the resilience pattern in `lib/coinbase.ts` (ping/pong heartbeat, exponential reconnect
backoff, resubscribe-on-open, `client_events` reconnect publish). Each client is a singleton.

**`src/lib/binance.ts`** — connect to the **all-market 24h ticker** stream (intended:
`wss://stream.binance.com:9443/ws/!ticker@arr`). It pushes an array of every changed symbol's
ticker ~once/sec over a single subscription — so one connection covers the whole Binance catalog
cheaply. For each array element: take the symbol (e.g. `BTCUSDT`), keep only those whose **quote**
is a USD-stable in preference order (`USDT` → `USDC` → `FDUSD`) and whose **base** maps to a
catalog token (via the normalization map, step 2); extract last price + 24h %. Write
`price:<BASE>:binance` (step 3). Skip non-preferred quotes so we don't overwrite a USDT price
with a thin pair.

**`src/lib/kraken.ts`** — Kraken has **no** single all-market stream; subscribe the `ticker`
channel for an explicit list of USD pairs = (catalog symbols ∩ Kraken-listed pairs). Build the
list at boot from the Token table; cap to a sane number (e.g. top ~300 by `rank`) if Kraken's
per-connection subscription limits require it. Normalize `XBT`→`BTC` etc. Write
`price:<BASE>:kraken`.

**`src/lib/coinbase.ts`** (refactor) — extend boot coverage beyond Pro-watched symbols: subscribe
the catalog's Coinbase-listed products at startup (use the lighter `ticker_batch`, ~5s, for the
breadth set; keep real-time `ticker` for symbols a Pro client actively watches via the existing
ref-count). Only subscribe products Coinbase actually lists (intersect catalog with Coinbase's
product list) to avoid dead-product subscribe noise. **Change the write target**: instead of
writing/publishing `price:<SYMBOL>` directly (current lines ~108-115), write
`price:<SYMBOL>:coinbase` and let the resolver own the canonical write + publish (step 3).

### 2. Symbol / pair normalization
**`src/lib/price-symbols.ts`** — single source of truth mapping `Token.symbol` ↔ each exchange's
product id, plus quote handling:
- `toBinanceBase(sym)` / `fromBinanceSymbol("BTCUSDT") -> { base:"BTC", quote:"USDT" }`
- `toKrakenPair(sym)` / `fromKrakenName(...)` with the `XBT`↔`BTC` (and any other) quirks
- `PREFERRED_BINANCE_QUOTES = ['USDT','USDC','FDUSD']`
Build the working set of catalog symbols once at boot from `prisma.token.findMany`. Keep all
exchange-specific quirks here so the clients stay dumb.

### 3. Resolver — canonical `price:<SYMBOL>`
**`src/lib/price-resolver.ts`** — each client calls `recordTick(symbol, exchange, price, change24h, quote)`
which:
1. Writes `price:<SYMBOL>:<exchange>` = `{price, change24h, quote, ts}` `EX 60`.
2. Recomputes the **canonical** value for that symbol by priority — prefer true-USD sources
   (`coinbase`, `kraken`) over USDT (`binance`); within the same tier prefer the freshest tick
   inside a staleness window (e.g. ≤ 15s). Ignore stale/expired per-exchange entries.
3. Writes canonical `price:<SYMBOL>` = `{price, change24h, source, ts}` `EX 60` **and**
   `redis.publish('price:<SYMBOL>', payload)` — this is the existing fan-out path
   (`ws/server.ts:handlePriceUpdate` subscribes to the `price:<SYMBOL>` channel), so Pro clients
   now receive resolved prices. The resolver is the **only** writer of the canonical key/channel.
- **Throttle**: cap canonical write+publish to at most ~1/sec per symbol (the all-market stream
  is already ~1/sec, but enforce so a busy symbol can't hammer Redis).

### 4. Boot wiring — `src/index.ts`
After the DB is reachable and after `coinbase.connect()`:
- build the normalization working set from the Token table,
- `binance.connect()` (guarded by `config.BINANCE_ENABLED`), `kraken.connect()`,
- subscribe each feed to its coverage set.
Wrap in try/catch so any single feed failing to connect never blocks boot or the others.
Resubscribe on reconnect is handled per-client (mirror `coinbase._onOpen`).

### 5. Config — `src/lib/config.ts`
- `BINANCE_ENABLED` (default true; set false for local/dev in a Binance-blocked region so the app
  degrades to Coinbase + Kraken instead of spamming reconnect errors).
- Optional overridable WS URLs (`BINANCE_WS_URL`, `KRAKEN_WS_URL`) for testing, defaulted to the
  verified production URLs.

## Hosting (must document — affects deploy, retrofit-12)
Binance market data is reachable only from permitted regions; it's keyed on the **backend's**
egress IP, so users anywhere are fine as long as the server is in a Binance-reachable region (an
EU/Asia host — **not** US for binance.com). Note this in the deploy doc. With `BINANCE_ENABLED=false`
the app still runs on Coinbase + Kraken. (Public market-data use is generally permitted, but give
each exchange's ToS a glance before relying on it commercially.)

## Gates (tests — mock the sockets; do NOT hit live exchanges in CI)
1. **Normalization**: `BTCUSDT → {BTC, USDT}`; `XBT → BTC`; round-trips for a few representative symbols.
2. **Client parse**: feed a captured Binance `!ticker@arr` array and a Kraken ticker message into
   the client's message handler → assert the right `price:<SYM>:<exchange>` keys are written.
3. **Resolver priority/freshness**: given per-exchange entries with differing quote + ts, the
   canonical pick follows USD-priority then freshness; stale entries are ignored; resolver writes
   **and** publishes the canonical key.
4. **Throttle**: rapid `recordTick` calls collapse to ≤ ~1 canonical write/sec/symbol.
5. **Boot with `BINANCE_ENABLED=false`**: only Coinbase + Kraken connect.
6. Existing `ws/server.ts` fan-out + moralis-webhook signature tests still pass.

## Commit (explicit add, no -A)
```bash
git add src/lib/binance.ts src/lib/kraken.ts \
        src/lib/price-symbols.ts src/lib/price-resolver.ts \
        src/lib/coinbase.ts src/lib/config.ts src/index.ts \
        tests/price-resolver.test.ts tests/price-symbols.test.ts tests/exchange-clients.test.ts \
        _claude/retrofit-16.md
git commit -m "feat(prices): multi-exchange WS ingestion (Coinbase+Binance+Kraken) with normalization + freshness/priority resolver (retrofit-16)"
```
Report: SHA, the verified WS URL/stream/field names actually used per exchange, the resolver
priority order, the throttle interval, and suite status.

## Dependency / ordering
- **retrofit-15** (read overlay) consumes `price:<SYMBOL>`; this retrofit produces it. Land 15
  first or together — 15 is verifiable now by seeding Redis; 16 fills it for real.
- **retrofit-14** (CMC null-price guard) is independent and already in flight — untouched here.
- Frontend Pro real-time recompute on the dashboard (Σ balance × `$prices`, matching the wallet)
  is **not** part of this — it's a direct frontend change I'll make separately.
