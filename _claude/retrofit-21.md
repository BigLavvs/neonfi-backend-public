# retrofit-21: per-token price history (token-detail chart + ATH/ATL + per-period PnL)

The token-detail page (`/wallet/[portfolioSlug]/[tokenSlug]`) is being wired to real data.
Holdings, allocation, all-time PnL, and tx history come from EXISTING endpoints
(`/portfolios/:id/assets` already returns `balance`, `netDeposit`, `pnlAllTime`,
`portfolioPercentage`; `/portfolios/:id/transactions`). The ONLY missing source is a
per-token **price history** for: the price chart, ATH/ATL, and the per-period PnL tabs.

There is no historical price data today (`Token` has only `currentPrice`). This retrofit adds
a daily price-snapshot table (mirroring `BalanceSnapshot`), samples it from the existing daily
job, and exposes `GET /tokens/:id/history`. Read the cited files first:
`prisma/schema.prisma` (Token, BalanceSnapshot), `src/jobs/snapshot.job.ts`,
`src/modules/tokens/{tokens.controller,tokens.service,tokens.schemas}.ts`,
`src/lib/live-price.ts` (getLivePriceMap), `tests/` snapshot + tokens specs.

---

## Part 1 — Schema: `TokenPriceSnapshot`
Add a daily per-token price snapshot table, modelled on `BalanceSnapshot` (composite PK for
idempotent per-day upsert; plain table, NOT a hypertable — keep it simple for MVP):

```prisma
model TokenPriceSnapshot {
  id           Int      @default(autoincrement())
  token        Token    @relation(fields: [tokenId], references: [id], onDelete: Cascade)
  tokenId      Int
  price        Decimal  @db.Decimal(20, 8)
  snapshotDate DateTime @db.Date

  createdAt    DateTime @default(now())

  @@id([tokenId, snapshotDate])
  @@index([tokenId])
  @@map("token_price_snapshot")
}
```
Add the back-relation to `Token`: `priceSnapshots TokenPriceSnapshot[]`.
Create the migration (`prisma migrate dev --name token_price_snapshot`). No TimescaleDB step.

---

## Part 2 — Daily sampling (extend `snapshot.job.ts`)
Token prices are GLOBAL (not per-user, not Pro-gated). After the existing portfolio loop in
`runSnapshotJob`, add a separate, failure-isolated step that upserts one row per catalog token
for today's UTC date (reuse the existing `todayUtcDate()` and the same idempotent-upsert pattern):

```ts
// retrofit-21: daily per-token price snapshot (global; powers the token-detail chart).
const tokens = await prisma.token.findMany({ select: { id: true, currentPrice: true } });
let tokenPricesSnapshotted = 0;
for (const t of tokens) {
  try {
    await prisma.tokenPriceSnapshot.upsert({
      where: { tokenId_snapshotDate: { tokenId: t.id, snapshotDate } },
      create: { tokenId: t.id, snapshotDate, price: t.currentPrice },
      update: { price: t.currentPrice },
    });
    tokenPricesSnapshotted++;
  } catch (err) {
    console.error('[snapshots]', JSON.stringify({ event: 'token_price_snapshot_failed', tokenId: t.id }), err);
  }
}
```
Add `tokenPricesSnapshotted` to `SnapshotJobResult` + the `job_complete` log. (Snapshots only
accrue when the job runs — daily granularity, same as the portfolio chart. Sparse in dev until
the job runs; that's expected and matches BalanceSnapshot behaviour.)

---

## Part 3 — Endpoint: `GET /tokens/:id/history?days=N`
- **tokens.schemas.ts**: `TokenHistoryQuerySchema` → `days` coerced int, clamp **1–3650**, default **365**.
- **tokens.service.ts**: `getTokenPriceHistory(id, days)`:
  1. `getTokenById(id)` first so an unknown id throws the existing `TokenError` 404 (don't invent a new path).
  2. Read `tokenPriceSnapshot` where `tokenId = id` AND `snapshotDate >= today − days`, `orderBy snapshotDate asc` → `points: [{ date: 'YYYY-MM-DD', price: Number }]`.
  3. **Latest live point**: overlay the live price via `getLivePriceMap([symbol])` (fallback `Token.currentPrice`); if the last snapshot's date isn't today, append `{ date: todayYMD, price: livePrice }` so the chart ends at "now".
  4. **ATH/ATL**: aggregate `min`/`max` of `price` over **ALL** snapshots for the token (a separate `prisma.tokenPriceSnapshot.aggregate`), then fold in the live price: `ath = max(maxSnapshot, live)`, `atl = min(minSnapshot, live)`. If no snapshots exist yet, `ath = atl = live`. (NOTE: this is "high/low since tracking began", not true all-time — CoinMarketCap's quote doesn't expose ATH/ATL. Acceptable MVP; document in the response comment.)
  5. Round prices to a sane wire scale (reuse the analytics `round`/2dp convention or Number()).
- **tokens.controller.ts**: `router.get('/:id/history', requireAuth, …)` — parse `id` (positive int, same guard as `/:id`), parse query via the schema, `ok({ points, ath, atl })`. **No plan gate** (matches `GET /tokens/:id`). Register this route so it doesn't collide with `/:id`.
- **DTO**: `{ points: Array<{ date: string; price: number }>; ath: number; atl: number }`.

---

## Gates (per-file, Neon-retry; dev server stopped)
1. **Snapshot job**: seed ≥2 tokens, run `runSnapshotJob()` → a `token_price_snapshot` row per token for today; `result.tokenPricesSnapshotted` matches; re-run same day → upsert (no dup rows, price updated).
2. **History endpoint**: seed snapshots for one token across several dates → `GET /tokens/:id/history?days=N` returns points ascending within the window, `ath`/`atl` = max/min incl. live; unknown id → 404; `days` clamps (e.g. 0 → 1, 99999 → 3650).
3. Existing snapshot + tokens tests still pass.

## Commit (explicit add, no -A)
```bash
git add prisma/schema.prisma prisma/migrations \
        src/jobs/snapshot.job.ts \
        src/modules/tokens/tokens.controller.ts src/modules/tokens/tokens.service.ts \
        src/modules/tokens/tokens.schemas.ts src/modules/tokens/tokens.dto.ts \
        tests/snapshot.job.test.ts tests/tokens.test.ts \
        _claude/retrofit-21.md
git commit -m "feat(tokens): daily TokenPriceSnapshot + GET /tokens/:id/history (chart + ATH/ATL) (retrofit-21)"
```
Report SHA + the migration name + the history sample source (daily snapshot job) + ATH/ATL semantics.
