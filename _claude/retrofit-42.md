# retrofit-42 — Real historical prices (CoinGecko) for chart snapshots + dev catch-up

Supersedes retrofit-41's SYNTHETIC seed with REAL daily history, and fixes why snapshots never
accrue on a dev box.

## Why no data after a day (confirmed in code — answers the standing question)
`snapshot.job.ts` registers `SNAPSHOT_CRON = '0 0 * * *'` (midnight UTC) via node-cron, which fires
ONLY while the process is alive and does NOT replay missed runs. A local dev backend that isn't up at
midnight UTC never snapshots — so history stays empty indefinitely. Also `balance_snapshot` is written
**Pro-only**. Both must be addressed for ongoing data (Part B); the backfill (Part A) populates now.

---

## Part A — real-history backfill via CoinGecko (replaces the synthetic generator)

Edit `src/scripts/backfill-snapshots.ts` (keep `npm run backfill:snapshots`). Swap step 1's
random-walk for real daily prices; keep the bulk-upsert + portfolio-value + cache-bust scaffolding.

### Config (`src/lib/config.ts`)
- `COINGECKO_API_KEY` — optional. With it, use the demo host + `x-cg-demo-api-key` header (≈30 req/min);
  without it, the public host (≈5–15 req/min, 429-prone). **Strongly recommend a free CoinGecko demo
  key** — without one this backfill is slow and rate-limited.
- `COINGECKO_BASE` — default `https://api.coingecko.com/api/v3` (demo key) / swap to
  `https://pro-api.coinmarketcap...` only for paid; demo key uses the same base with the header.

### Steps
1. **symbol → CoinGecko id map** — `GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1..3`
   (top ~750). Map each catalog `symbol` → the FIRST (highest-market-cap) id, so ticker collisions
   resolve to the canonical coin (same rank-priority lesson as retrofit-40). One-time, 3 calls.
2. **Per-token daily history**, in priority order — **held tokens ALWAYS**, then catalog by `rank`,
   up to `REAL_HISTORY_LIMIT` (default 250):
   - `GET /coins/{id}/market_chart?vs_currency=usd&days=365` → `{ prices: [[tsMs, price], …] }`. The
     free tier auto-returns DAILY granularity for `days > 90` (do NOT send `interval=daily` — that's
     paid and 401s on free). Collapse to one price per UTC calendar date (last point of each day).
   - **Throttle** between calls (≥2.5 s with key / ≥6 s without) and retry `429` with exponential
     backoff. This is the slow part; it's a one-off.
   - Upsert `token_price_snapshot (tokenId, snapshotDate, price)` with the REAL prices
     (`ON CONFLICT … DO UPDATE`), overwriting any synthetic rows from retrofit-41.
   - A token with no mapped id, or a fetch that keeps failing → **fall back to the retrofit-41
     synthetic series** for that token, so every chart still renders (real where we can, plausible
     elsewhere). Log which tokens fell back.
3. **Portfolio value** — unchanged from retrofit-41: per portfolio per day, `Σ(balance × that-day
   price)` using whichever series (real or synthetic) each held token ended up with. Upsert
   `balance_snapshot` for every portfolio (read path isn't plan-gated).
4. **Cache bust** — unchanged (`portfolioDerivedCacheKeys` + `overview:<userId>:*`).

### Summary log
`{ mapped, realTokens, syntheticFallback, tokenRows, portfolioRows }` so the run is auditable.

---

## Part B — make snapshots accrue going forward (the "automatic" part)

### B1. Catch-up on boot (dev-friendly)
In `src/index.ts`, under `NODE_ENV !== 'test'`, after `startSnapshotScheduler()`: if **today's**
snapshot is missing, run `runSnapshotJob()` once at startup (catch-up), then the cron handles the
rest. This way each day the dev server is started it captures a point, instead of needing to be alive
at exactly midnight UTC. Guard it so it never blocks boot (fire-and-forget with a `.catch`).

### B2. Pro-gate note (decision, not auto-applied)
`balance_snapshot` writes are Pro-only in `runSnapshotJob`. On a FREE demo account, portfolio
snapshots still won't accrue even with B1. To grow on a free demo, either run the account as Pro or
relax that gate for non-prod. Token price snapshots are NOT gated, so token-detail charts accrue
regardless. Leave the gate as-is unless you confirm you want it relaxed.

---

## Tests
- symbol→id map picks the highest-mcap id for a colliding ticker (mock `/coins/markets`).
- a mocked `market_chart` response yields DAYS `token_price_snapshot` rows ending on the latest real
  price; a token with no mapping falls back to a synthetic series (still DAYS rows).
- `balance_snapshot` value == Σ(balance × that-day price); re-run idempotent (ON CONFLICT).
- B1: with today's snapshot absent, boot catch-up writes it; with it present, no duplicate.
- `tsc --noEmit` clean; suite green; `NODE_ENV=test`; dev stopped. (Mock all CoinGecko fetches in
  tests — no live network.)

## Commit & run
Commit named files only (`src/scripts/backfill-snapshots.ts`, `src/lib/config.ts`, `src/index.ts`,
tests). Report SHA. Set `COINGECKO_API_KEY` in `.env` (free demo key), then
`npm run backfill:snapshots`; paste the summary line. Leave dev stopped.

## After it lands
Token-detail charts show REAL price history for the held + top-250 coins (synthetic for the long
tail); the portfolio chart reflects real prices for your holdings. With B1, each dev-server start also
captures that day's point.
