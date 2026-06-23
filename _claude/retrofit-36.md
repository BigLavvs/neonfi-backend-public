# retrofit-36 — Gate.io + KuCoin streaming clients (long-tail real-time breadth)

## Why
Binance/Coinbase/Kraken cover majors well but miss the long tail (small/mid-caps that aren't listed
on those USD venues), which is most of the frozen catalog. Gate.io and KuCoin list **thousands** of
those tokens with free public WS tickers, and — unlike Binance — are reachable from this dev host, so
this is the change that visibly un-freezes the catalog in dev *and* prod. Both plug into the
multi-source resolver from retrofit-35 (their priorities `gate:4`, `kucoin:5` and per-exchange keys
`price:<SYM>:gate` / `price:<SYM>:kucoin` already exist there — no resolver change needed).

Prereq: retrofit-35 landed (SOURCE_PRIORITY/EXCHANGES include `gate` + `kucoin`).

Both quote in **USDT** (≈USD), consistent with the existing Binance path — record `quote:'USDT'` and
let the resolver use it as-is (no FX). Mirror the resilience pattern of `src/lib/coinbase.ts`
(connect, exponential backoff, resubscribe-on-open, message-driven liveness) — do not invent a new
pattern.

---

## A. Gate.io — `src/lib/gate.ts` (new)
VERIFIED against https://www.gate.io/docs/developers/apiv4/ws/en/ (2026-06, public, no key):
- WS URL: `wss://api.gateio.ws/ws/v4/`  (add `GATE_WS_URL` to config with this default)
- Subscribe (chunk the payload to ≤100 pairs/frame):
  ```json
  { "time": <unixSeconds>, "channel": "spot.tickers", "event": "subscribe", "payload": ["BTC_USDT","ETH_USDT"] }
  ```
- Update frame:
  ```json
  { "channel": "spot.tickers", "event": "update",
    "result": { "currency_pair": "BTC_USDT", "last": "15743.4", "change_percentage": "-1.8254", ... } }
  ```
  All numeric fields are STRINGS. `last` = last price; `change_percentage` = 24h %. Ignore frames
  where `event` !== `"update"` (subscribe acks have `event:"subscribe"`), and any non-`spot.tickers`
  channel.
- Symbols are `BASE_QUOTE` underscore-delimited.
- Keepalive: send `{ "time": <unixSeconds>, "channel": "spot.ping" }` periodically (server replies
  `spot.pong`); treat any inbound frame as liveness (same watchdog idea as Coinbase heartbeats).

Client shape (mirror Coinbase): `connect()/disconnect()`, reconnect backoff, and
`subscribeForCoverage(pairs: string[])` that stores the pair set, sends chunked subscribes when
connected, and resubscribes the full set on open. `handleMessage(raw)` (public, for tests):
```ts
// for each update result:
const norm = fromGatePair(result.currency_pair);     // -> { base, quote } or null
if (!norm || norm.quote !== 'USDT') continue;
if (!isCatalogSymbol(norm.base)) continue;
const price = parseFloat(result.last);
if (!Number.isFinite(price)) continue;
const change24h = parseFloat(result.change_percentage);
recordTick(norm.base, 'gate', price, Number.isFinite(change24h) ? change24h : 0, 'USDT')
  .catch((e) => console.error(`[gate] recordTick ${norm.base} error:`, e.message));
```
`export const gate = new GateClient();`

REST coverage list (best-effort, like Coinbase): `GET https://api.gateio.ws/api/v4/spot/currency_pairs`
→ array of `{ id: "BTC_USDT", base, quote, trade_status }`. Keep `quote === 'USDT'` and
`trade_status === 'tradable'` (VERIFY field name in REST docs); return the base-symbol set. Coverage =
catalog ∩ that set → `toGatePair(sym)` (`"BTC"` → `"BTC_USDT"`). If the REST call fails, fall back to
subscribing the catalog directly (Gate ignores unknown pairs) — never a silent no-op (same pattern as
Coinbase in index.ts).

---

## B. KuCoin — `src/lib/kucoin.ts` (new)
VERIFIED against https://www.kucoin.com/docs/websocket/ (2026-06, public). KuCoin's connect flow is
unique — do NOT connect to a static URL:
1. `POST https://api.kucoin.com/api/v1/bullet-public` (no auth) →
   `{ data: { token, instanceServers: [{ endpoint, pingInterval, pingTimeout }] } }`.
2. Connect to `` `${endpoint}?token=${token}&connectId=${uuid}` ``. Server sends `{type:'welcome'}`.
3. **App-level ping** is mandatory: send `{ id: <ts>, type: 'ping' }` every `pingInterval` ms
   (~18s); server replies `{type:'pong'}`. Missing pings → server closes. (This replaces the
   ws.ping() heartbeat used by the other clients.)
4. Subscribe ALL tickers in one shot (no per-symbol list needed):
   ```json
   { "id": <ts>, "type": "subscribe", "topic": "/market/snapshot:all", "response": true }
   ```
   Prefer `/market/snapshot:all` because its payload carries BOTH last price and 24h change. (If the
   doc shows snapshot:all is per-symbol-only, use `/market/ticker:all`, which streams every symbol
   but has NO 24h change → record `change24h: 0`.) VERIFY the exact topic + data shape against the
   doc and pick the one that includes a 24h change field.
5. Message (snapshot:all): `{ type:'message', topic:'/market/snapshot:all', subject:'BTC-USDT',
   data:{ data:{ symbol, lastTradedPrice, changeRate, ... } } }`. `lastTradedPrice` = last;
   `changeRate` is a FRACTION (e.g. 0.012 = +1.2%) → multiply by 100 for the percent we store.
   (ticker:all shape: `subject` = symbol, `data:{ price, ... }`.)

Because KuCoin streams the whole market, there's no coverage list — **filter incoming to the catalog**:
```ts
const norm = fromKucoinSymbol(symbol);               // "BTC-USDT" -> { base, quote } or null
if (!norm || norm.quote !== 'USDT') return;
if (!isCatalogSymbol(norm.base)) return;
const price = parseFloat(lastTradedPrice);
if (!Number.isFinite(price)) return;
const change24h = changeRate != null ? parseFloat(changeRate) * 100 : 0;
recordTick(norm.base, 'kucoin', price, Number.isFinite(change24h) ? change24h : 0, 'USDT')
  .catch((e) => console.error(`[kucoin] recordTick ${norm.base} error:`, e.message));
```
Resilience: on disconnect, re-run bullet-public (token is short-lived) → reconnect → resubscribe →
restart the ping timer. Reuse the backoff constants. `export const kucoin = new KucoinClient();`
Add `KUCOIN_BULLET_URL` (default `https://api.kucoin.com/api/v1/bullet-public`) to config.

Symbols are `BASE-QUOTE` hyphen-delimited. (Coverage cross-check, optional: `GET
https://api.kucoin.com/api/v2/symbols` → `{data:[{symbol, baseCurrency, quoteCurrency, enableTrading}]}`.)

---

## C. `src/lib/price-symbols.ts` (add normalizers)
```ts
// Gate.io: "BTC_USDT" <-> base/quote
export function fromGatePair(pair: string): { base: string; quote: string } | null {
  const [base, quote] = pair.toUpperCase().split('_');
  return base && quote ? { base, quote } : null;
}
export function toGatePair(sym: string): string { return `${sym.toUpperCase()}_USDT`; }

// KuCoin: "BTC-USDT" <-> base/quote
export function fromKucoinSymbol(symbol: string): { base: string; quote: string } | null {
  const [base, quote] = symbol.toUpperCase().split('-');
  return base && quote ? { base, quote } : null;
}
```
(Reuse `KRAKEN_TO_STANDARD`-style legacy mapping only if a base needs it; not expected for these.)

## D. `src/index.ts` (boot wiring, gated by env like Binance)
After the Kraken block in `startPriceFeeds`:
```ts
// Gate.io — explicit coverage list (catalog ∩ Gate USDT pairs).
try {
  if (config.GATE_ENABLED) {
    const gateListed = await fetchGateUsdtBaseSymbols();          // best-effort; [] -> fall back to catalog
    const catalog = [...getCatalogSymbols()];
    const coverage = (gateListed.size ? catalog.filter((s) => gateListed.has(s)) : catalog).map(toGatePair);
    console.log(JSON.stringify({ event: 'gate_boot', coverage: coverage.length }));
    gate.connect();
    gate.subscribeForCoverage(coverage);
  }
} catch (e) { console.error('[neonfi-backend] gate connect failed', e); }

// KuCoin — subscribes the whole market, filters to catalog in handleMessage (no coverage list).
try {
  if (config.KUCOIN_ENABLED) { kucoin.connect(); }
} catch (e) { console.error('[neonfi-backend] kucoin connect failed', e); }
```
Add `GATE_ENABLED` / `KUCOIN_ENABLED` flags to config (same non-coerced boolean pattern as
`BINANCE_ENABLED`; default `true` so they run in dev — they're reachable here). Extend the
`price_feeds_boot` log with `gate`/`kucoin` enabled flags. Add both to graceful shutdown.

## Tests
- `tests/exchange-clients*`: Gate — feed a captured `spot.tickers` update → records `'gate'` with the
  right base/price/percent; non-USDT or non-catalog frames are dropped; subscribe-ack frames ignored.
  KuCoin — feed a `/market/snapshot:all` message → records `'kucoin'` with `lastTradedPrice` and
  `changeRate*100`; non-catalog symbols dropped; assert the bullet→connect→ping→subscribe sequence
  via the public `handleMessage` + a mockable bullet fetch.
- `tests/price-resolver.test.ts`: a symbol fresh ONLY on gate/kucoin resolves from it; when binance/
  coinbase are also fresh they win (priority). 
- `tsc --noEmit` clean; suites green, `NODE_ENV=test`, dev stopped.

## Commit
Named files only: `src/lib/gate.ts`, `src/lib/kucoin.ts`, `src/lib/price-symbols.ts`,
`src/lib/config.ts`, `src/index.ts`, and the test files. Report SHA. Leave dev stopped.

## After it lands
Re-measure in the browser (Starting Assets catalog): far more long-tail rows should tick. Anything
still frozen is either a stablecoin (correct) or a coin no reachable exchange lists at all.
