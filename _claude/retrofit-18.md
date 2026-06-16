# retrofit-18: real Top Movers in /overview + Refresh-Prices cache-bust

Two small backend changes the frontend already expects. Read the cited files first.

---

## Part 1 — add `topMovers` to GET /overview (frontend #35)
The dashboard "Top Movers Today" card was hardcoded mock; the frontend now consumes
`data.topMovers` from /overview (empty state shown until this lands). Compute it from the live
24h change the resolver already writes.

Source of truth: retrofit-16's resolver writes canonical `price:<SYMBOL>` =
`{price, change24h, source, ts}` (EX 60) for every symbol with a live tick. So movers = catalog
tokens ranked by `change24h`.

In `src/modules/overview/overview.service.ts` (the service behind GET /overview), after the existing
aggregate is built, add a `topMovers` field:
1. Load the catalog token symbol→name map (`prisma.token.findMany({ select: { symbol, name } })`) —
   or reuse a catalog list already loaded for price overlay.
2. `redis.mget(...symbols.map(s => 'price:' + s))`; parse each payload's `change24h` (skip null /
   missing / non-finite).
3. Build `{ symbol, name, change24h }[]`, sort by `Math.abs(change24h)` desc (biggest movers, both
   directions), take the top **6**.
4. Return it as `data.topMovers` on the /overview response.

Shape the frontend expects: `topMovers: Array<{ symbol: string; name: string; change24h: number }>`.

Caching: movers are global (same for everyone), so cache the computed list under a single Redis key
`overview_top_movers` for **60s** to avoid recomputing per user/request. (Independent of the
per-portfolio `portfolio_pnl` cache.)

Edge: if no symbols have a fresh tick (e.g. feeds down), return `[]` — the frontend shows its empty
state, no error.

---

## Part 2 — `POST /prices/refresh` must bust the caller's derived caches (frontend #32)
Symptom: the free-tier "Refresh Prices" button writes fresh `price:<SYMBOL>` values but the
displayed totals don't change, because GET /overview returns the **cached** `portfolio_pnl:<id>` /
`analytics_*:<id>` values (60s TTL, retrofit-15) computed before the refresh.

Fix: in `src/modules/prices/prices.service.ts` `refreshPrices` (or the controller after it
succeeds), after writing the refreshed prices, invalidate the caller's derived caches so the next
GET /overview recomputes with the new prices:
1. Get the user's portfolio IDs (`prisma.portfolio.findMany({ where: { userId }, select: { id } }`).
2. Delete their derived cache keys. There's already a helper —
   `src/lib/portfolio-cache-keys.ts` `portfolioDerivedCacheKeys(portfolioId)` (used by
   transactions.service for CUD invalidation) — call it per portfolio and `redis.del(...keys)`.
   (That covers `portfolio_pnl:<id>` + `analytics_{summary,performance,holdings}:<id>`.)
3. Guard with `.catch` — a Redis failure must not fail the refresh response.

After this, the frontend flow works: refresh → POST /prices/refresh (writes prices + busts caches)
→ `invalidateAll()` re-fetches /overview → recomputed totals reflect the fresh prices.

---

## Gates (per-file, Neon-retry; dev server stopped)
1. **topMovers**: seed a couple of `price:<SYM>` keys with differing `change24h`; GET /overview →
   `data.topMovers` is sorted by |change24h| desc, capped at 6, each `{symbol,name,change24h}`; no
   ticks → `[]`. 60s cache key set.
2. **refresh cache-bust**: prime `portfolio_pnl:<id>`; call refresh; assert the key is deleted (next
   /overview recomputes). Redis-down path doesn't throw.
3. Existing overview + prices tests still pass.

## Commit (explicit add, no -A)
```bash
git add src/modules/overview/overview.service.ts \
        src/modules/prices/prices.service.ts \
        tests/overview.test.ts tests/prices.test.ts \
        _claude/retrofit-18.md
git commit -m "feat(overview): real topMovers from live 24h change; fix(prices): refresh busts derived caches (retrofit-18)"
```
Report SHA + the movers cap/sort + that refresh now invalidates portfolio_pnl/analytics.
