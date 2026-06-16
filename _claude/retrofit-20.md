# retrofit-20: real 24h PnL in /overview + real Top-Mover sparklines

Two backend gaps the Overview audit surfaced. The frontend already consumes both
(`data.stats.pnl24h*` and `topMovers[].spark`). Read the cited files first.

---

## Part 1 — real 24h PnL in GET /overview totals
Today `derive.ts` hardcodes `pnl24h: 0, pnl24hValue: 0` (it can't compute 24h without history),
so the dashboard's "24h PnL" card is permanently $0.00. Compute it in the overview service from
the daily `BalanceSnapshot` history (same source the Stage-14 analytics module uses).

In `src/modules/overview/overview.service.ts` `buildOverview`, after `totals.totalValue` is known:
1. Confirm the snapshot model/fields in `prisma/schema.prisma` (e.g. `BalanceSnapshot { portfolioId,
   value/totalValue, snapshotAt/capturedAt }`) and reuse analytics.service's existing snapshot read
   pattern rather than inventing a new query.
2. For the user's portfolios, get **the most recent snapshot per portfolio with timestamp ≤ now − 24h**
   and sum their values → `value24hAgo`. (Snapshots are daily, so this is effectively "since the last
   daily close" — acceptable for MVP 24h.)
3. `pnl24hValue = totals.totalValue − value24hAgo`; `pnl24h = value24hAgo > 0 ? (pnl24hValue /
   value24hAgo) * 100 : 0`. Round to the existing wire scale.
4. If there's no snapshot ≥24h old (new account) → leave `0/0` (frontend shows +$0.00, fine).
5. Set these on `totals` (override derive's zeros). Leave `pnl7d/pnl30d` as-is (out of scope).

Keep it inside the existing per-user overview cache (60s) — no new cache.

---

## Part 2 — real Top-Mover sparklines (`topMovers[].spark`)
The mover trend lines were hardcoded up/down shapes. Give each mover a real recent price series.
There's no per-token history today, so capture a small sampled one from the resolver.

**Capture (price-resolver.ts):** in `resolveCanonical`, after writing the canonical `price:<SYMBOL>`,
also append the price to a capped per-symbol history list, **sampled at ≥5 min per symbol** (track a
`lastHistAt` Map like the throttle) so the list spans time, not seconds:
```ts
// sampled history for sparklines (retrofit-20): ~12 points, one per ≥5 min
await redis.lpush(`price_hist:${sym}`, String(winner.tick.price));
await redis.ltrim(`price_hist:${sym}`, 0, 11);
await redis.expire(`price_hist:${sym}`, 86400);
```
(Only when the 5-min sample gate passes; guard with `.catch`.)

**Serve (overview.service.ts `computeTopMovers`, retrofit-18):** for the ≤6 chosen movers, read their
history and attach `spark` (oldest→newest):
```ts
const raw = await redis.lrange(`price_hist:${sym}`, 0, -1); // newest→oldest
const spark = raw.map(Number).filter(Number.isFinite).reverse();
```
Add `spark: number[]` to each `topMovers` item (DTO `OverviewDTO['topMovers']` already needs the
field — update overview.dto.ts to `{ symbol, name, change24h, spark }`). Empty list → `spark: []`
(frontend draws a flat line until ≥2 points accrue).

---

## Gates (per-file, Neon-retry; dev server stopped)
1. **24h PnL**: seed a portfolio + a `BalanceSnapshot` dated ~25h ago with a known value, plus a live
   `price:<SYM>` so current value differs; GET /overview → `totals.pnl24hValue == current − snapshot`,
   `pnl24h` the matching %. No snapshot → 0.
2. **spark**: `rpush/lpush price_hist:BTC` a few values; GET /overview → the BTC mover's `spark` is the
   series oldest→newest; symbol with no list → `spark: []`.
3. Existing overview + resolver/price tests still pass.

## Commit (explicit add, no -A)
```bash
git add src/modules/overview/overview.service.ts src/modules/overview/overview.dto.ts \
        src/lib/price-resolver.ts \
        tests/overview.test.ts tests/price-resolver.test.ts \
        _claude/retrofit-20.md
git commit -m "feat(overview): real 24h PnL from snapshots + real top-mover sparklines from sampled price history (retrofit-20)"
```
Report SHA + the 24h-PnL source (snapshot ≤24h) + the spark sample interval/cap.
