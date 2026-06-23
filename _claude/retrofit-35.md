# retrofit-35 — Binance-first priority + Kraken trade/bbo hybrid (multi-source groundwork)

## Why (decision, reversing part of retrofit-32)
The catalog has ~499 tokens but only the symbols a *reachable* exchange streams ever tick; the rest
sit on the seed price. Measured in the browser: of the top ~47 catalog rows, ~19 tick live in 24s
(Coinbase working well) — the rest are stablecoins (correctly flat), coins with **no Coinbase/Kraken
USD source** (BNB, XMR, LEO…), or thin alts that only print occasionally.

Per product decision we are widening real-time coverage with **more streaming exchanges**. This
retrofit lays the groundwork and does the two changes that need no new client files:

1. **Binance becomes the priority source** (it has the broadest *liquid* real-time coverage; one
   all-market stream ~1/sec). It's geo-blocked on the dev host, so this is a no-op in dev and the
   real win in prod — but the priority must be set now so 36/37 slot in cleanly.
2. **Kraken gains a bbo sub-feed** alongside its existing last-trade feed. retrofit-32 rejected bbo
   because the mid `(bid+ask)/2` drifts from the real trade price on thin pairs. We keep that concern
   honest by **preferring the last trade and only using the bbo-mid when it is MORE CURRENT** — i.e.
   bbo keeps a thin Kraken pair moving when it hasn't traded recently, but a live trade always wins.
   This is exactly "use whichever of trade/bbo is more current/relevant."

Gate.io + KuCoin (retrofit-36) and OKX + Bybit (retrofit-37) add the long-tail breadth; this
retrofit just makes the resolver ready for them and sets the priority order.

## Run order
Standalone. After it lands, dev coverage barely changes (Binance blocked here; Kraken bbo only helps
Kraken-listed thin pairs). The visible breadth jump is retrofit-36. Apply this first so the resolver
contract is in place.

---

## Change 1 — `src/lib/price-resolver.ts`

### 1a. Priority order + exchange list
Replace the retrofit-32 constants with the full intended source order. Binance first (broadest, fast;
USDT≈USD accepted), then Coinbase (true USD), then the deep USDT exchanges (OKX/Bybit) and long-tail
USDT exchanges (Gate/KuCoin) that 36/37 add, then Kraken as the true-USD fallback. Listing exchanges
whose clients don't exist yet is harmless — their per-exchange keys are simply never present.

```ts
// retrofit-35: priority = SPEED/breadth of the source's real-time stream. Binance (all-market
// ~1/sec) first; Coinbase next (true-USD, per-trade). OKX/Bybit (retrofit-37) and Gate/KuCoin
// (retrofit-36) fill coverage for coins the top two don't list. Kraken is the true-USD fallback,
// with its bbo-mid sub-feed ('kraken_bbo') MERGED into the 'kraken' candidate below (more-current
// wins) rather than ranked as its own tier. Resolver still picks the highest-priority FRESH source.
const SOURCE_PRIORITY: Record<string, number> = {
  binance: 0,
  coinbase: 1,
  okx: 2,
  bybit: 3,
  gate: 4,
  kucoin: 5,
  kraken: 6,
};
// Every per-exchange key we read back. 'kraken_bbo' is read but collapsed into 'kraken' in
// resolveCanonical (it is NOT a standalone priority tier).
const EXCHANGES = ['binance', 'coinbase', 'okx', 'bybit', 'gate', 'kucoin', 'kraken', 'kraken_bbo'] as const;
```

### 1b. Merge Kraken trade + bbo by recency in `resolveCanonical`
Today the function builds `candidates[]` then sorts by priority, then freshness. Insert a Kraken
merge step BEFORE the sort: collapse `kraken` (last-trade) and `kraken_bbo` (bbo-mid) into a single
candidate = whichever has the newer `ts`; on a tie the **trade** wins (a real execution is more
relevant than a mid). Keep the real source label for the published payload so the firehose `source`
stays honest.

```ts
  // ... after reading raws into fresh per-exchange ticks (apply the SAME staleness filter as today) ...
  const fresh = new Map<string, ExchangeTick>();
  raws.forEach((raw, i) => {
    if (!raw) return;
    let tick: ExchangeTick;
    try { tick = JSON.parse(raw) as ExchangeTick; } catch { return; }
    if (!Number.isFinite(tick.price)) return;
    if (now - tick.ts > STALENESS_WINDOW_MS) return; // stale — ignore
    fresh.set(EXCHANGES[i]!, tick);
  });

  // retrofit-35: collapse Kraken's two sub-feeds. Prefer the last trade; let the bbo-mid surface
  // only when it is strictly more recent (keeps thin Kraken pairs live without overriding a live
  // trade). `krakenLabel` carries the real source into the payload.
  let krakenLabel: 'kraken' | 'kraken_bbo' = 'kraken';
  const kt = fresh.get('kraken');
  const kb = fresh.get('kraken_bbo');
  if (kt || kb) {
    const useBbo = kt && kb ? kb.ts > kt.ts : !kt;
    fresh.set('kraken', (useBbo ? kb : kt)!);
    krakenLabel = useBbo ? 'kraken_bbo' : 'kraken';
  }
  fresh.delete('kraken_bbo'); // merged — not a standalone candidate

  if (fresh.size === 0) return;

  const candidates = [...fresh.entries()].map(([exchange, tick]) => ({ exchange, tick }));
  candidates.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.exchange] ?? 99;
    const pb = SOURCE_PRIORITY[b.exchange] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.tick.ts - a.tick.ts; // freshest within a tier
  });

  const winner = candidates[0]!;
  const sourceLabel = winner.exchange === 'kraken' ? krakenLabel : winner.exchange;
  const payload = JSON.stringify({
    price: winner.tick.price,
    change24h: winner.tick.change24h,
    source: sourceLabel,
    ts: now,
  });
  // ... canonical write + change-dedupe publish + history sampling unchanged ...
```

Keep `STALENESS_WINDOW_MS`, `PRICE_TTL_S`, change-dedupe (`lastPublishedPrice`), the canonical
`price:<SYMBOL>` write, and history sampling exactly as they are. Add `SOURCE_PRIORITY`/`EXCHANGES`
to `__internals` if they're exported there.

### 1c. Cross-source outlier guard (collision / bad-print defense)
Ticker symbols are NOT unique across exchanges — a long-tail "FOO" on Gate/KuCoin can be a *different*
asset than the catalog's "FOO", producing a confidently-wrong price. Add a conservative guard inside
`resolveCanonical`, applied to the FRESH candidate set just before the priority sort:

- Only ONE source fresh → accept it (nothing to cross-check).
- TWO OR MORE fresh → compute the median price of the fresh set and DROP any candidate outside
  `[median / PRICE_OUTLIER_RATIO, median * PRICE_OUTLIER_RATIO]`. Log each drop:
  `{ event:'price_outlier_dropped', symbol, exchange, price, median }`.
- If the guard would empty the set (e.g. exactly two sources that disagree beyond the ratio, no
  majority), keep the highest-PRIORITY candidate and log the disagreement — never resolve to zero.

Add `PRICE_OUTLIER_RATIO` to config (default `5` — a fresh source >5× or <1/5× the median is
rejected; generous for real volatility, tight enough to catch gross collisions). Runs on ≤7 entries,
so cost is negligible. It only filters CANDIDACY — the priority + freshness selection below is
unchanged (we are keeping the priority-gated policy, not switching to pure-freshness).

---

## Change 2 — `src/lib/kraken.ts` (add a bbo sub-feed; keep the trade feed unchanged)
Parameterize the client so one class drives both feeds, then export a second singleton for bbo.

- Constructor opts: `{ eventTrigger?: 'trades' | 'bbo'; source?: string }`, defaulting to
  `'trades'` / `'kraken'` (current behavior — do NOT change the default feed).
- `_sendSubscribe`: include `event_trigger: this.eventTrigger` in `params` (verified against
  https://docs.kraken.com/api/docs/websocket-v2/ticker — `ticker` channel accepts
  `event_trigger: 'bbo' | 'trades'`, default `trades`; the frame schema is identical for both and
  always carries `last`, `bid`, `ask`, `change_pct`).
- `handleMessage`: choose the price by mode —
  - `'trades'` → `price = t.last` (unchanged).
  - `'bbo'` → `price = (bid + ask) / 2` from `t.bid` / `t.ask`; skip the frame if either is missing
    or non-finite or ≤ 0.
  - record under `this.source`: `recordTick(norm.base, this.source, price, change_pct, 'USD')`.
- Export the new singleton next to `export const kraken`:

```ts
export const kraken = new KrakenClient();                                  // trades → 'kraken'
export const krakenBbo = new KrakenClient(undefined, {                     // bbo-mid → 'kraken_bbo'
  eventTrigger: 'bbo',
  source: 'kraken_bbo',
});
```

Both reuse the existing resilience (ping/pong, backoff, resubscribe-on-open) — no other behavior
change. Update the file header note to record that bbo is now used as a *fallback* sub-feed (and that
this is a deliberate, scoped reversal of retrofit-32's "no bbo" stance, mitigated by the
more-current-wins merge in the resolver).

---

## Change 3 — `src/index.ts` (boot the bbo feed)
In `startPriceFeeds`, where Kraken connects, also connect + subscribe the bbo client to the SAME
coverage pairs:

```ts
  // Kraken — last-trade feed (true USD), plus a bbo-mid sub-feed the resolver uses only when it's
  // more current than the last trade (retrofit-35).
  try {
    kraken.connect();
    kraken.subscribe(getKrakenCoverage());
    krakenBbo.connect();
    krakenBbo.subscribe(getKrakenCoverage());
  } catch (e) {
    console.error('[neonfi-backend] kraken connect failed', e);
  }
```

Import `krakenBbo` alongside `kraken`. Add `krakenBbo` to the graceful-shutdown disconnect list if
`kraken` is in one.

---

## Change 4 — Binance enablement (env only, no code)
The priority change (Change 1) already makes Binance win wherever it's reachable. Binance is
`BINANCE_ENABLED=false` on this dev host because the egress IP is geo-blocked (HTTP 451) — leave it
false in dev (enabling it only adds reconnect-error log spam with no data). **In a non-blocked / prod
environment set `BINANCE_ENABLED=true`** so the all-market firehose feeds as the priority source. Do
NOT commit `.env`. Just document this in the retrofit notes / deploy checklist.

---

## Change 5 — Source-visibility readout (read-only debug endpoint)
So you can CONFIRM which source is pricing each token and spot disagreements, add a read-only
endpoint (no writes, no new deps). Extend `pricesRouter` (or a small new controller):

`GET /api/v1/prices/debug?symbol=BTC` (behind `requireAuth`) →
```json
{ "data": { "symbol": "BTC",
  "canonical": { "price": 65187.6, "source": "coinbase", "ts": 1718000000000 },
  "sources": {
    "binance":    { "price": 65190.1, "ts": 1718000000000, "ageMs": 420,  "stale": false },
    "coinbase":   { "price": 65187.6, "ts": 1718000000000, "ageMs": 110,  "stale": false },
    "kraken":     { "price": 65185.0, "ts": 1718000000000, "ageMs": 9300, "stale": false },
    "kraken_bbo": { "price": 65186.2, "ts": 1718000000000, "ageMs": 300,  "stale": false }
  } } }
```
Implementation: one `mget` of `price:<SYM>` (canonical) + `price:<SYM>:<exchange>` for every
`EXCHANGES` entry; compute `ageMs = now - ts` and `stale = ageMs > STALENESS_WINDOW_MS`. With no
`symbol`, return the first N catalog symbols (cap N, e.g. 50) as an at-a-glance board. Diagnostic, so
keep it `requireAuth` (or pro-only) — not public.

Optional (low risk, do only if quick): also carry `source` into each firehose `prices[]` entry in
`ws/server.ts` so the frontend *could* badge the live source later. The endpoint above is the primary
readout and needs no frontend change.

---

## Tests
- `tests/exchange-clients*` (Kraken): feed a captured `event_trigger:'bbo'` ticker frame (has
  `bid`/`ask`) → records `'kraken_bbo'` with the mid; feed a `'trades'` frame → records `'kraken'`
  with `last`. Cover the skip path when `bid`/`ask` are missing on a bbo frame.
- `tests/price-resolver.test.ts`:
  - Binance fresh + Coinbase fresh → Binance wins (new priority).
  - Kraken trade + kraken_bbo both fresh → the one with the newer `ts` wins; equal `ts` → trade
    (`kraken`) wins; bbo wins only when the trade is older/stale; published `source` reflects which.
  - Existing change-dedupe + TTL-refresh + staleness cases stay green; update any case that assumed
    the old `{coinbase:0,kraken:1,binance:2}` order.
  - Outlier guard (1c): with ≥2 fresh sources where one is absurd (e.g. 100× the others), the absurd
    one is dropped and a sane source wins; a single fresh source is accepted as-is; two sources
    disagreeing beyond the ratio keep the higher-priority one and log.
- Debug endpoint (Change 5): returns the canonical source + each exchange's `ageMs`/`stale`; stale
  entries flagged; unknown symbol → empty `sources`.
- `tsc --noEmit` clean; resolver + exchange-client + endpoint suites green with `NODE_ENV=test` and
  dev stopped.

## Commit
Named files only (no `-A`): `src/lib/price-resolver.ts`, `src/lib/kraken.ts`, `src/lib/config.ts`,
`src/index.ts`, the prices debug controller/route, and the test files. Report the SHA. Leave dev
stopped.

## After it lands
Browser cadence is ~unchanged in dev (Binance blocked; Kraken bbo only helps Kraken-listed thin
pairs). The real coverage jump is retrofit-36 (Gate.io + KuCoin), which is reachable in dev too.
