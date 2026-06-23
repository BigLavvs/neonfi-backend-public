# retrofit-32 — Fastest-source-first, keeping TRUE last-trade prices (no bbo)

## Decision (revised)
We considered Kraken `event_trigger: bbo` to maximize update frequency, and **rejected it**: bbo
emits the order-book **mid** `(bid+ask)/2`, which is not the last traded price. For liquid pairs
mid ≈ last, but for thin pairs the mid drifts from the actual trade price and from what users see
on CoinGecko/exchanges. A portfolio tracker should show the **real last-trade price**, so we keep
last-trade everywhere and rank sources by speed.

This means update frequency naturally tracks real trading activity: a token that isn't trading
shows a steady last price (correct — it genuinely hasn't moved), while busy tokens tick several
times/sec. The big win is just making sure the *fastest real source* is the one we use.

## Run order
After retrofit-31 confirms Coinbase is ingesting (`coinbase_first_tick`, `coinbaseCoverage` > 0).
**First just measure** — once Coinbase feeds, the existing resolver may already satisfy the policy
(Coinbase and Kraken are both top-tier and "freshest wins", so the faster-ticking source —
Coinbase — already wins by default). If the cadence looks right in the browser, this retrofit may
be unnecessary. Apply it only to make the preference explicit/deterministic.

## The only change (if applied) — `src/lib/price-resolver.ts`
Make the speed preference explicit instead of relying on a freshness tie between equal tiers:

```ts
// retrofit-32: priority = SPEED of the source's last-trade stream (measured on this host:
// Coinbase ~3 trades/sec for majors >> Kraken trades; Binance is geo-blocked here). The resolver
// already picks the highest-priority source with a FRESH (non-stale) tick and falls back down the
// list — i.e. "use the fastest source that has the pair; fall back only when it's missing/stale."
// All sources report LAST-TRADE price (no bbo/mid). If the host ever reaches Binance, consider
// moving it to 0 — but weigh its USDT≈USD quote against Coinbase/Kraken's true USD.
const SOURCE_PRIORITY: Record<string, number> = { coinbase: 0, kraken: 1, binance: 2 };
```

Do NOT change `src/lib/kraken.ts` — it stays on the default `trades` trigger reading `last`
(true last-trade). No bbo, no mid. Leave the staleness window, change-dedupe, canonical write,
and history sampling untouched.

## Tests
- `tests/price-resolver.test.ts`: with both Coinbase and Kraken fresh for a symbol, **Coinbase
  wins**; Kraken used only when Coinbase is stale/absent; Binance only when it's the sole fresh
  source. Keep the change-dedupe + TTL-refresh cases.
- `tsc --noEmit` + resolver/exchange-clients suites green, `NODE_ENV=test`, dev stopped. Commit
  named files (`src/lib/price-resolver.ts` + the test) — no `-A`. Report SHA. Leave dev stopped.

## After it lands
Re-measure in the browser. Tokens that trade often (majors, busy alts) should update multiple
times/sec via Coinbase last-trade; quiet tokens update when they actually trade. Anything still
frozen is a coverage gap on the reachable sources (Coinbase/Kraken) — not something to paper over
with a synthetic mid.
