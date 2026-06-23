# retrofit-37 — OKX + Bybit streaming clients (depth + resilience)

## Why
OKX and Bybit add deep, fast real-time coverage of majors and mid-caps (mostly overlapping Binance,
but reachable when Binance isn't, and adding source redundancy so a single venue outage doesn't
freeze prices). They slot into the retrofit-35 resolver at `okx:2` / `bybit:3` (keys
`price:<SYM>:okx` / `price:<SYM>:bybit` already listed in EXCHANGES) — no resolver change needed.

Prereq: retrofit-35 landed. Both quote in **USDT** (≈USD) — record `quote:'USDT'`, no FX. Mirror the
`src/lib/coinbase.ts` resilience pattern. Both use **per-symbol** subscriptions, so each needs a
coverage list (catalog ∩ the exchange's SPOT USDT instruments), like Coinbase/Gate — NOT an
all-market stream.

---

## A. OKX — `src/lib/okx.ts` (new)
VERIFY against https://www.okx.com/docs-v5/en/#public-data-websocket-tickers-channel (2026-06, public,
no key):
- WS URL: `wss://ws.okx.com:8443/ws/v5/public`  (config `OKX_WS_URL`)
- Subscribe (batch args; chunk to a safe size):
  ```json
  { "op": "subscribe", "args": [ { "channel": "tickers", "instId": "BTC-USDT" }, { "channel": "tickers", "instId": "ETH-USDT" } ] }
  ```
- Message:
  ```json
  { "arg": { "channel": "tickers", "instId": "BTC-USDT" },
    "data": [ { "instId": "BTC-USDT", "last": "15743.4", "open24h": "16030.1", ... } ] }
  ```
  `last` = last price. OKX tickers has **no direct 24h percent** — compute it:
  `change24h = open24h > 0 ? (last - open24h) / open24h * 100 : 0`.
- Symbols: `BASE-QUOTE` hyphen (spot). Keep `quote === 'USDT'`.
- Keepalive: if no data for ~25s, send the literal string `"ping"` (NOT JSON); server replies
  `"pong"`. Treat any inbound frame as liveness.

```ts
// per data element:
const [base, quote] = String(d.instId).toUpperCase().split('-');
if (quote !== 'USDT' || !base) continue;
if (!isCatalogSymbol(base)) continue;
const price = parseFloat(d.last);
if (!Number.isFinite(price)) continue;
const open = parseFloat(d.open24h);
const change24h = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;
recordTick(base, 'okx', price, change24h, 'USDT').catch((e) => console.error(`[okx] recordTick ${base} error:`, e.message));
```
Coverage REST: `GET https://www.okx.com/api/v5/public/instruments?instType=SPOT` →
`data:[{instId, baseCcy, quoteCcy, state}]`; keep `quoteCcy==='USDT'` && `state==='live'`. Coverage =
catalog ∩ those bases → `instId = "${base}-USDT"`. `subscribeForCoverage(instIds)`; resubscribe on
open; fall back to subscribing catalog `-USDT` instIds if REST fails. `export const okx = new OkxClient();`

---

## B. Bybit — `src/lib/bybit.ts` (new)
VERIFY against https://bybit-exchange.github.io/docs/v5/websocket/public/ticker (2026-06, public):
- WS URL: `wss://stream.bybit.com/v5/public/spot`  (config `BYBIT_WS_URL`)
- Subscribe (per symbol via topic string; batch the args array, chunk to ≤10 per Bybit limits —
  VERIFY current limit):
  ```json
  { "op": "subscribe", "args": [ "tickers.BTCUSDT", "tickers.ETHUSDT" ] }
  ```
- Message (spot tickers push a full **snapshot** each time):
  ```json
  { "topic": "tickers.BTCUSDT", "type": "snapshot",
    "data": { "symbol": "BTCUSDT", "lastPrice": "15743.4", "price24hPcnt": "-0.0182", ... } }
  ```
  `lastPrice` = last; `price24hPcnt` = 24h change as a **fraction** → `*100` for percent.
- Symbols are concatenated `BASEQUOTE` (like Binance) → reuse the suffix-match parse
  (`fromBinanceSymbol` handles USDT/USDC/FDUSD; for Bybit, USDT/USDC). Keep only USDT (USDC optional).
- Keepalive: send `{ "op": "ping" }` every ~20s; server replies `{ "op":"pong" }` / `ret_msg:"pong"`.

```ts
const d = msg.data; // snapshot object
const norm = fromBinanceSymbol(String(d.symbol)); // BASEQUOTE -> {base,quote} via preferred-quote suffixes
if (!norm || norm.quote !== 'USDT') return;
if (!isCatalogSymbol(norm.base)) return;
const price = parseFloat(d.lastPrice);
if (!Number.isFinite(price)) return;
const pct = d.price24hPcnt != null ? parseFloat(d.price24hPcnt) * 100 : 0;
recordTick(norm.base, 'bybit', price, Number.isFinite(pct) ? pct : 0, 'USDT').catch((e) => console.error(`[bybit] recordTick ${norm.base} error:`, e.message));
```
Coverage REST: `GET https://api.bybit.com/v5/market/instruments-info?category=spot` →
`result.list:[{symbol, baseCoin, quoteCoin, status}]`; keep `quoteCoin==='USDT'` &&
`status==='Trading'`. Coverage = catalog ∩ those bases → topic `"tickers.${base}USDT"`.
`export const bybit = new BybitClient();`

---

## C. `src/index.ts` (boot wiring, env-gated)
After the Gate/KuCoin block:
```ts
try {
  if (config.OKX_ENABLED) {
    const okxListed = await fetchOkxUsdtBaseSymbols();
    const catalog = [...getCatalogSymbols()];
    const instIds = (okxListed.size ? catalog.filter((s) => okxListed.has(s)) : catalog).map((s) => `${s}-USDT`);
    console.log(JSON.stringify({ event: 'okx_boot', coverage: instIds.length }));
    okx.connect(); okx.subscribeForCoverage(instIds);
  }
} catch (e) { console.error('[neonfi-backend] okx connect failed', e); }

try {
  if (config.BYBIT_ENABLED) {
    const bybitListed = await fetchBybitUsdtBaseSymbols();
    const catalog = [...getCatalogSymbols()];
    const topics = (bybitListed.size ? catalog.filter((s) => bybitListed.has(s)) : catalog).map((s) => `tickers.${s}USDT`);
    console.log(JSON.stringify({ event: 'bybit_boot', coverage: topics.length }));
    bybit.connect(); bybit.subscribeForCoverage(topics);
  }
} catch (e) { console.error('[neonfi-backend] bybit connect failed', e); }
```
Add `OKX_ENABLED` / `BYBIT_ENABLED` (default `true`) + the two WS URLs to config (same boolean
pattern as `BINANCE_ENABLED`). Extend `price_feeds_boot` with okx/bybit flags. Add both to graceful
shutdown.

## Tests
- `tests/exchange-clients*`: OKX — feed a captured `tickers` frame → records `'okx'` with `last` and
  the computed `(last-open24h)/open24h*100`; non-USDT/non-catalog dropped. Bybit — feed a snapshot
  → records `'bybit'` with `lastPrice` and `price24hPcnt*100`; symbol suffix parse correct;
  non-catalog dropped.
- `tests/price-resolver.test.ts`: a symbol fresh on okx/bybit only resolves from it; binance/coinbase
  win when also fresh (priority 0/1 < 2/3).
- `tsc --noEmit` clean; suites green, `NODE_ENV=test`, dev stopped.

## Commit
Named files only: `src/lib/okx.ts`, `src/lib/bybit.ts`, `src/lib/config.ts`, `src/index.ts`, and the
test files. Report SHA. Leave dev stopped.

## After it lands
With Coinbase + Kraken(+bbo) + Gate + KuCoin + OKX + Bybit live (and Binance in prod), the resolver
has 5–7 reachable real-time sources. Re-measure: the only frozen rows left should be stablecoins
(correct) and coins listed on NO supported venue.
