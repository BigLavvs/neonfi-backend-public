# retrofit-30 — Fix the Coinbase Advanced Trade feed (it ingests NOTHING today)

## Why (proven from the user's machine, not a guess)

The realtime prices feel dead because **2 of the 3 exchange feeds deliver nothing**, so the
app runs on Kraken alone — a thin trickle. Measured directly from the browser on the user's
host:

- **Binance** (`wss://stream.binance.com:9443/ws/!ticker@arr`): socket **opens but 0 messages
  in 6s** → geo-blocked on this egress IP. `BINANCE_ENABLED=false` is therefore correct; leave
  it off. Not our problem to fix.
- **Coinbase, current backend subscribe** `{type:'subscribe',product_ids:[...],channels:['ticker']}`
  (note `channels`, an array): **1 message, 0 ticks** → Advanced Trade rejected it.
- **Coinbase, correct subscribe** `{type:'subscribe',product_ids:[...],channel:'ticker'}`
  (singular `channel`): **49 messages in 6s for 3 products** → fast, per-trade.
- **Kraken** v2: 11 msgs/6s, working — parser is already correct, do not touch its parse path.

On top of the wrong subscribe field, `src/lib/coinbase.ts` **parses the legacy Coinbase Pro /
Exchange shape**, not Advanced Trade. The endpoint in `.env` is
`COINBASE_WS_URL=wss://advanced-trade-ws.coinbase.com` (Advanced Trade), so the parser never
matches and records zero ticks even when a subscribe succeeds.

### Verified Advanced Trade ticker shape (captured live)

Routing key is `msg.channel` (NOT `msg.type`), and tickers are nested:

```json
{
  "channel": "ticker",
  "timestamp": "...",
  "sequence_num": 0,
  "events": [
    { "type": "snapshot|update",
      "tickers": [
        { "type": "ticker",
          "product_id": "BTC-USD",
          "price": "64899.54",
          "price_percent_chg_24_h": "-2.3265998",
          "best_bid": "64899", "best_ask": "64899.01", "...": "..." }
      ] }
  ]
}
```

Current code reads `msg['type']==='ticker'`, `msg['product_id']`, `msg['price']`,
`msg['price_percent_chg_24h']` — all wrong for Advanced Trade:
- route on `msg['channel'] === 'ticker'` (not `type`)
- tickers are in `msg.events[].tickers[]` (not top level)
- the 24h change field is **`price_percent_chg_24_h`** (underscores around `24` and `h`), not
  `price_percent_chg_24h`.

## What to change — `src/lib/coinbase.ts` ONLY

Read the whole file first and cite line numbers in your summary. Keep the singleton, the
ping/pong heartbeat, the reconnect/backoff, the `client_events` reconnect publish, and the
resilience constants exactly as they are. This is a parse + subscribe-format fix, plus moving
coverage to the real-time channel.

1. **Subscribe frames → Advanced Trade format (singular `channel`).**
   - `_sendSubscribe(symbol)` and `_sendUnsubscribe(symbol)`: send
     `{ type:'subscribe'|'unsubscribe', product_ids:[`${symbol}-USD`], channel:'ticker' }`
     (singular `channel`, not `channels`).
   - `_sendBatchSubscribe(productIds)` (coverage): send
     `{ type:'subscribe', product_ids: chunk, channel:'ticker' }` — i.e. **use the real-time
     `ticker` channel, not `ticker_batch`**, so coverage updates per-trade (sub-second) instead
     of every ~5s. Keep the chunking (CHUNK 100 is fine).

2. **Parser → Advanced Trade shape.** Rewrite `_onMessage` routing:
   - Parse JSON. Switch on `msg['channel']` (string), not `msg['type']`.
   - `case 'ticker'`: for each `ev of msg.events ?? []`, for each `t of ev.tickers ?? []`:
     - `productId = t.product_id` → split on `-` into `[base, quote]`; skip if no base.
     - `price = parseFloat(t.price)`; skip if not finite.
     - `change24h = t.price_percent_chg_24_h != null ? parseFloat(t.price_percent_chg_24_h) : 0`.
     - `recordTick(base.toUpperCase(), 'coinbase', price, change24h, (quote ?? 'USD').toUpperCase())`
       — same call signature/catch as today.
   - `case 'subscriptions'`: ignore (it's the ack), or debug-log the product count once.
   - Treat ANY inbound frame as liveness: call `this._clearPongTimer()` at the top of
     `_onMessage` (Advanced Trade sends `channel:'heartbeats'`/`'subscriptions'`/`'ticker'`,
     never the legacy `type:'heartbeat'`, so the old liveness branch is dead).

3. **(Optional, recommended) heartbeats channel.** On `_onOpen`, after resubscribing, also send
   `{ type:'subscribe', channel:'heartbeats' }` so Coinbase keeps the socket warm during quiet
   markets. Not required for correctness (protocol ping/pong already runs), so skip if it
   complicates the diff.

4. **`subscribeToSymbol` / `unsubscribeFromSymbol`** are now redundant for coverage (the catalog
   coverage subscribes the same real-time `ticker`). Leave them in place (still correct with the
   singular-`channel` fix) — they're harmless and unused. Do not delete in this retrofit.

5. Do NOT touch `src/lib/price-resolver.ts`, `src/lib/kraken.ts`, `src/lib/binance.ts`, or
   `src/ws/server.ts`. Coinbase is `SOURCE_PRIORITY` tier 0 already, so once it streams,
   freshest-of-(coinbase,kraken) wins and majors update sub-second. No resolver change needed.

## Tests

Update `tests/coinbase.test.ts` (or wherever the Coinbase client is unit-tested — grep for
`handleMessage`/`CoinbaseClient`). If `_onMessage` is private and tests can't reach it, expose a
public `handleMessage(raw: string)` mirroring the Kraken/Binance clients (they already do this)
and have `_onMessage` delegate to it. Cover:
- An Advanced Trade `channel:'ticker'` frame with `events[].tickers[]` → `recordTick` called with
  the right base/price/change for each ticker (mock `recordTick`, assert args).
- `price_percent_chg_24_h` parsed into change24h (assert the exact field name is read).
- A `channel:'subscriptions'` ack → no `recordTick`.
- A malformed / non-ticker frame → no throw, no `recordTick`.
- The subscribe frame uses `channel:'ticker'` (singular) — assert on the JSON the client sends
  (capture via a fake ws.send), so the field-name regression can't come back.

Run the Coinbase suite (and the resolver/ws suites if your change touches their imports) green
with `NODE_ENV=test` and the dev server stopped. Commit named files only (no `-A`). Report the
SHA. Leave the dev server stopped so the user can restart and confirm.

## After it lands
User restarts `npm run dev`. Expected: the firehose jumps from ~1 symbol / 2.5s (Kraken-only)
to many ticks/sec across the catalog (Coinbase real-time + Kraken), and the UI updates feel
live — with no throttle/batch anywhere (already removed in retrofit-29 / cc42954).
