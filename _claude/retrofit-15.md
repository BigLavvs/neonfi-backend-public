# retrofit-15: consume live prices on read (source-agnostic)

> Scope changed from the original draft. retrofit-15 is now **only the read-path
> overlay** — it makes every value the app shows prefer the live `price:<SYMBOL>`
> cache over the seeded `Token.currentPrice`. It does **not** populate that cache.
> Cache population (Coinbase + Binance + Kraken WS ingestion) is **retrofit-16**.
> This split was deliberate: retrofit-15 is testable in isolation by seeding Redis,
> and lands value the moment any writer (retrofit-16, or the existing
> `POST /prices/refresh`) fills `price:<SYMBOL>`.

## The problem (root cause of "prices are hardcoded")
Every value the app shows is computed from **`Token.currentPrice`** — the **seeded** DB value:
- `portfolios/derive.ts:78` (`computeFromDb`): `totalValue += balance * Number(a.token.currentPrice)`
- `assets/assets.dto.ts` (`toAssetDTO` + `computeTotalValue`)
- `tokens/tokens.dto.ts` (`toTokenListDTO`/`toTokenDetailDTO`)
- `overview/overview.service.ts` (allocation/holdings/totals)
- `analytics/analytics.service.ts` (`buildHoldings`)

`Token.currentPrice` only moves on the 6-hourly CMC metadata sync (retrofit-14), so prices
are effectively frozen at their seed values. Meanwhile a live price cache **already exists**:
`lib/coinbase.ts` writes `redis SET price:<SYMBOL> {price,change24h,timestamp} EX 60` on every
tick (and retrofit-16 will add Binance + Kraken to it). **Nothing on the read path consults it.**

Per Idowu: live *streaming* stays Pro-only, but **every user must see the latest cached price
at page-load time**. So the read paths must prefer `price:<SYMBOL>` and fall back to
`Token.currentPrice` only when there's no fresh tick.

## Plan

### 1. Shared live-price helper
New `src/lib/live-price.ts`:
```ts
import { redis } from './redis.js';
// symbol → live USD price for symbols that have a fresh canonical Redis tick.
// Misses are omitted (caller falls back to Token.currentPrice). Never throws —
// a Redis failure yields an empty map, so reads degrade to currentPrice.
export async function getLivePriceMap(symbols: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return new Map();
  const out = new Map<string, number>();
  try {
    const raw = await redis.mget(...unique.map((s) => `price:${s}`));
    unique.forEach((sym, i) => {
      const v = raw[i];
      if (!v) return;
      try {
        const p = (JSON.parse(v) as { price?: unknown }).price;
        if (typeof p === 'number' && p > 0) out.set(sym, p);
      } catch { /* skip malformed */ }
    });
  } catch { /* return what we have */ }
  return out;
}
```
Reads the **canonical** `price:<SYMBOL>` key. retrofit-16 owns writing that canonical key
(resolved across exchanges); retrofit-15 stays agnostic about which exchange produced it.

### 2. Overlay live price on every read path (`live ?? currentPrice`)
Each consumer fetches `getLivePriceMap(symbols)` once, then uses
`liveMap.get(symbol) ?? Number(token.currentPrice)`:
- **`portfolios/derive.ts` `computeFromDb`** — fetch the live map for the portfolio's asset
  symbols; use it in the `totalValue` loop (lines 75-80). Highest-leverage change: drives
  dashboard totals, wallet net worth, `/overview` totals, and all-time PnL.
- **`assets/assets.dto.ts`** — `toAssetDTO`/`computeTotalValue` are sync mappers; resolve the
  live map in `assets.service` (`listAssets`/`getAsset`) and pass a `priceMap` param in, or
  resolve each price in the service before mapping.
- **`tokens/tokens.dto.ts`** — same pattern via `tokens.service` (`listTokens`/`getTokenById`).
- **`overview/overview.service.ts`** — overlay live price in allocation/holdings/totals (it also
  calls `computeDerived`, which the derive.ts change above already fixes — don't double-apply).
- **`analytics/analytics.service.ts` `buildHoldings`** — overlay live price.

Keep `change24h` from the payload available if you later want a real 24h column (out of scope —
just don't discard it).

### 3. Cache freshness
`derive.ts` caches `portfolio_pnl:<id>` for **5 min**; analytics caches similarly. With live
prices that makes totals up to 5 min stale at load. Reduce these **price-dependent** caches to
**60s** (matches the `price:<SYMBOL>` TTL) so "latest at load" actually holds. This is all
reads (no extra writes), so the only cost is a little more recompute — fine at MVP scale. State
the chosen TTL in the commit message. (Real-time *ticking* for Pro is a separate frontend
recompute off the WS stream — not governed by this cache.)

### 4. Note on retrofit-14 / CMC
retrofit-14 (CMC metadata-sync null-price guard) is **independent** and already in flight — do
not touch those files here. With Coinbase/Binance/Kraken as the live source (retrofit-16), CMC is
only needed for logos + market-cap/rank metadata, not prices.

## Gates (tests — per-file, Neon-retry)
1. Seed a Token `currentPrice = 100`; `redis SET price:<SYM> {"price":250,"change24h":0,"timestamp":...}`.
   Assert `GET /portfolios/:id` totalValue, `GET /overview` totals + allocation, and
   `GET /portfolios/:id/assets` value all reflect **250**, not 100.
2. No Redis tick for a held symbol → value falls back to `currentPrice` (100).
3. `getLivePriceMap` returns only symbols with fresh ticks; Redis down → empty map (no throw).
4. Confirm the touched modules (portfolios/assets/tokens/overview/analytics) + moralis-webhook
   signature tests still pass.

## Commit (explicit add, no -A)
```bash
git add src/lib/live-price.ts \
        src/modules/portfolios/derive.ts \
        src/modules/assets/assets.dto.ts src/modules/assets/assets.service.ts \
        src/modules/tokens/tokens.dto.ts src/modules/tokens/tokens.service.ts \
        src/modules/overview/overview.service.ts src/modules/analytics/analytics.service.ts \
        tests/live-price.test.ts _claude/retrofit-15.md
git commit -m "feat(prices): overlay live price:<SYMBOL> cache over seeded currentPrice on all reads; 60s value cache (retrofit-15)"
```
Report SHA + which read paths now overlay live price + the chosen cache TTL + suite status.
