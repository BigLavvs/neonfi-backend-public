# retrofit-31 — Make the price-feed boot OBSERVABLE + self-heal Coinbase coverage

## Why (measured, not guessed)

retrofit-30 fixed the Coinbase Advanced Trade subscribe format + parser, and it's committed
(aa14544). But at runtime the app is **still Kraken-only** — Coinbase is connected yet ingesting
nothing. Proof, measured from the browser against the live exchanges vs the running app:

- **LINK**: Coinbase fires **12 ticks / 8s** directly; in the app it changes **0× / 12s**.
- ATOM 6×, DOT 4×, TON 5×, SHIB 6× on Coinbase in 8s — all frozen in the app.
- The app's update set (SOL, XRP, BNB, BCH, LTC…) matches **Kraken's** low trade cadence, not
  Coinbase's. So Coinbase is contributing ~nothing.
- `https://api.exchange.coinbase.com/products` returns **200 with 825 products** (reachable), so
  the coverage source itself works from this network.

We can't see *why* Coinbase ingests nothing from the browser. This retrofit adds the missing
backend visibility and removes the two ways the Coinbase coverage can silently become a no-op.

## Changes

### 1. `src/index.ts` — boot summary + resilient coverage

In `startPriceFeeds()`:

- After `loadCatalogSymbols()` and computing the Coinbase coverage, **log one summary line** so
  the running process's feed wiring is visible at a glance:
  ```ts
  console.log(JSON.stringify({
    event: 'price_feeds_boot',
    binanceEnabled: config.BINANCE_ENABLED,
    catalog: getCatalogSymbols().size,
    coinbaseListed: coinbaseListed.size,
    coinbaseCoverage: coverage.length,
    krakenCoverage: getKrakenCoverage().length,
  }));
  ```
- **Resilience:** today coverage is gated on `coinbaseListed.size > 0`; if that REST fetch ever
  returns empty, Coinbase subscribes to NOTHING. Change it so an empty/failed product list falls
  back to subscribing the catalog symbols directly (Coinbase silently ignores any unknown
  product; a few dead-product warnings are far better than zero coverage):
  ```ts
  const coinbaseListed = await fetchCoinbaseUsdBaseSymbols();
  const catalog = [...getCatalogSymbols()];
  const coverage = coinbaseListed.size > 0
    ? catalog.filter((s) => coinbaseListed.has(s))
    : catalog; // fallback: REST product list unavailable — subscribe the catalog directly
  if (coinbaseListed.size === 0) {
    console.warn(JSON.stringify({ event: 'coinbase_products_unavailable_fallback', coverage: coverage.length }));
  }
  coinbase.subscribeForCoverage(coverage);
  ```
  (Keep the existing try/catch around it.)

### 2. `src/lib/coinbase.ts` — prove ingestion + surface errors

- **First-tick beacon:** the first time `handleMessage` actually records a Coinbase tick, log
  once (a module-level `let loggedFirstTick = false`): `console.log(JSON.stringify({ event:
  'coinbase_first_tick', symbol }))`. This is the single most useful line — if it never appears,
  Coinbase ingestion is dead even though the socket is "connected".
- **Subscribe ack/err visibility:** in `handleMessage`, when `msg.channel === 'subscriptions'`,
  log once the number of products Coinbase confirms (dig the `events[].subscriptions.ticker`
  array length if present). And add handling for an error frame: Advanced Trade signals a bad
  subscribe with a frame carrying `type:'error'` / a top-level `message`/`error` field (it is NOT
  on `channel`). If a parsed frame has no `channel` but has an `error`/`message`/`type:'error'`,
  `console.error(JSON.stringify({ event:'coinbase_ws_error', detail: <the message/raw, truncated 200ch> }))`.
  This catches the "subscribe rejected → 0 ingestion" case.
- Do not change the ticker parse path or the subscribe format (retrofit-30 is correct and
  verified — my browser probe with the same `channel:'ticker'` format gets ticks).

## Tests
Light: extend `tests/coinbase.test.ts` so the `subscriptions` ack and an `error`-style frame each
hit their new branch without throwing and without calling `recordTick`; assert the first-tick log
fires at most once across two ticker frames (spy on `console.log`, or just assert no throw +
recordTick counts). Keep the existing 239–243 green. Run `tsc --noEmit` + the coinbase suite,
`NODE_ENV=test`, dev stopped. Commit named files (`src/index.ts`, `src/lib/coinbase.ts`,
`tests/coinbase.test.ts`) — no `-A`. Report SHA. **Leave the dev server stopped.**

## After it lands — the decisive read
Restart `npm run dev` and watch the first ~20 lines. Three outcomes:
1. No `price_feeds_boot` line at all → the running process predated this build (stale) — the
   restart itself fixes it.
2. `coinbaseCoverage: 0` (or the fallback warning) → the product intersection was the culprit;
   the fallback now subscribes the catalog.
3. `coinbaseCoverage: <big>` but no `coinbase_first_tick` within a few seconds (and/or a
   `coinbase_ws_error`) → Coinbase is rejecting the subscribe; the error line tells us why.

Paste those lines back and we'll know exactly which, instead of guessing.
