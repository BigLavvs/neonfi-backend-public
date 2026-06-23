# retrofit-78 — Finish the connected-history honesty job (retrofit-77 gaps + H11 + display)

Authored after live-verifying retrofit-77 and running a fresh deep audit on the running app
(account demo3, wallet `0xcB1C…905`). retrofit-77 works for **newly-synced** portfolios, but the
audit found it does **not** fix existing ones, plus a second writer that re-introduces the bug, the
H11 chart problem, and two display contradictions. All are user-visible and all are the same theme:
**don't present approximate/synthetic connected data as precise.**

Live evidence (Portfolio 2, currently worth $16.24, on-chain ~0.0056 ETH + dust the whole time):
- Dashboard **24h +$0.02** ✓ (real Jun-19 snapshot wins) — retrofit-77 holds here.
- **30d −$203.32 / −94.33%** ✗ garbage (analytics summary).
- Dashboard "Portfolio Value" chart Y-axis runs **$12 → $214**; series is
  `…May-12 $223 · Jun-15 $169 · Jun-19 $12.22 · Jun-20 $16.24` — a fake ~93% cliff exactly where
  the real daily snapshots begin.
- Token-detail (ETH): **All-time −$4.62 / −32.41%** shown next to **"Total invested $0.00"**.

---

## N3 (CRITICAL) — retrofit-77 doesn't fix EXISTING connected portfolios
retrofit-77's migration set existing rows to `approx=false` on the assumption that "long-lived
portfolios already have real daily snapshots winning the match." True for **24h** (the Jun-19 real
snapshot wins), but **false for 7d/30d**: the daily job only started ~Jun-19, so the only snapshots
≥7/30 days old are the **approximate multi-year backfill** rows — and they're `approx=false`, so
`findSnapshotAtOrBefore` happily uses them. Result on the user's real portfolio:
`pnl30dValue = 16.24 − 215.54 (May-20 backfill row) = −$203 / −94.33%`. Pure fiction.

**Fix — retro-classify existing connected backfill snapshots as `approx=true`.** The trailing
**consecutive-daily** run (the real daily-job series) must stay `approx=false`; everything earlier
(the spaced multi-year backfill) becomes `approx=true`. Concrete, robust method (data migration /
one-off script, idempotent):

```
For each CONNECTED portfolio, order its balance_snapshot rows by snapshotDate DESC. Walk from the
newest while each row is exactly 1 day before the previous (the real daily streak) — leave those
approx=false. At the first gap >1 day, mark that row and all older rows approx=true.
```
Equivalent set-based version: mark `approx=true` for any connected snapshot that is NOT part of the
trailing 1-day-spaced run ending at the portfolio's latest snapshot. (Manual portfolios untouched —
their snapshots come only from the daily job + retrofit-76, all real.)

Edge cases: a connected portfolio with ONLY backfill (never had a daily run, e.g. created moments
ago) → all rows approx=true → 24h/7d/30d all "—" until the daily job/resync writes a real row
(correct; this is the retrofit-77 fresh-sync behaviour). After the migration, connected 7d/30d read
"—" until real daily history accrues — honest, and immediately kills the −94% garbage.

Validate: Portfolio 2 → 30d becomes "—"/0 (not −94%); 24h still +$0.02; all-time still −96%
(earliest snapshot still readable — `findEarliestSnapshotByPortfolio` doesn't filter approx).

---

## A1 (HIGH) — `scripts/backfill-snapshots.ts` re-introduces the bug AND clobbers real rows
The standalone chart-history backfill (`npm run backfill:snapshots`) writes `balance_snapshot` for
**every portfolio, 365 days** (recent dates included) as `Σ(current balance × that-day price)` —
real CoinGecko price where mapped, else a **synthetic random walk** (`seriesFor`). It INSERTs via
raw SQL (`backfill-snapshots.ts:224-228`) with **no `approx` column → defaults `approx=false`**, so
every demo/synthetic point is eligible as a 24h/7d/30d baseline (re-introducing the retrofit-77 bug
for any portfolio it touches). Worse, its `ON CONFLICT … DO UPDATE SET "value" = EXCLUDED."value"`
**overwrites real daily snapshots' values with synthetic ones** if re-run after the daily job.

**Fix:**
1. Write `approx=true` for the balance rows (add the column to the INSERT). It's an estimate by
   construction (the file's own header: "uses CURRENT balances for all past days — a demo curve").
2. Don't clobber real history on conflict:
   `ON CONFLICT ("portfolioId","snapshotDate") DO UPDATE SET "value" = EXCLUDED."value", "approx" = true WHERE "balance_snapshot"."approx" = true`
   (only overwrite rows that are already approximate; leave real daily rows alone).
3. (Optional, related) the token_price_snapshot synthetic series feeds token price charts — see A2.

Validate: after a backfill run, a portfolio's real daily snapshots keep their values + stay
approx=false; the script's historical rows are approx=true and never serve as a short-term baseline.

---

## H11 (HIGH) — connected value history is approximate AND conflates transfers with performance
Two compounding problems behind the fake chart + the −96% all-time:
1. **Approximate pricing.** Backfill points are `historical balance × ~today's price`
   (`sync.ts:390`), so they don't reflect real past value.
2. **Transfers read as performance.** All-time = `currentValue − earliestSnapshot`. This wallet's
   own transaction history shows it **moved ETH out** over time (sells/sends of 0.145, 0.063,
   0.016, 0.0018, 0.001 ETH). Those withdrawals shrink "value", so snapshot-delta reports them as a
   −96% "loss" — but the user didn't lose it, they moved it. A deposit would inflate it the same
   wrong way.

This is the single biggest remaining accuracy gap and it's on the **primary dashboard chart**, not
just a number. Options (pick per product taste):
- **Chart:** draw only the real (`approx=false`) snapshots as the solid line; render the
  approximate/backfill segment visually distinct (dashed/greyed "estimated") or omit it. Reuses the
  retrofit-77 `approx` flag — the chart read (`findAllSnapshotsAscByPortfolio`) currently ignores
  the flag; have it return `approx` so the frontend can style/segment.
- **All-time:** either (a) net out transfers (compute PnL against net deposits/withdrawals using the
  imported transfer ledger, the honest number), or (b) if flows can't be valued reliably, **relabel**
  it "Value change since tracking (incl. deposits/withdrawals)" so it isn't presented as investment
  return. (a) is the real fix; (b) is the honest stopgap.
- **Deeper (optional):** value historical snapshots with **real historical prices per block** so the
  backfill is accurate; expensive, schedule separately if pursued.

Validate: a connected wallet that only moved funds out doesn't show a fabricated cliff or a
"−96% loss"; the chart's estimated portion is visually distinguished from observed data.

---

## D1 (MEDIUM) — no-baseline short-term renders "+0.00%", not "—" (the originally-planned item)
Backend returns `0` (not `null`) for a no-baseline short-term window; the dashboard formats `0` as
`fmtPct(0)` = **"+0.00%" green** (`dashboard/+page.ts:240-247`, same on performance/wallet). After
N3, connected 7d/30d will be 0 → they'd read "flat", implying "no change" when we mean "unknown".

**Fix:** carry the no-baseline case as `null` end-to-end and map it to "—":
- derive.ts `computeShortTermDeltas` / `snapshotDelta`: return `null` (not 0) for pnl{24h,7d,30d}
  value+pct when there's no in-tolerance non-approx baseline. (Keep the totals-exclusion behaviour:
  a `null` portfolio contributes 0 to and is excluded from the headline, per retrofit-75 M16 — so
  `totals == Σ rows` still holds.)
- DTOs: allow `number | null` for those six fields.
- Frontend: render `null` as "—" (neutral, not green/red) on the dashboard 24h card + per-portfolio
  rows, performance cards, and wallet. `0` (a genuine flat real delta) still shows "+0.00%".

Validate: freshly-synced connected portfolio shows "—" (not +0.00%) for 24h/7d/30d; a portfolio
with a real flat day shows +0.00%; headline still reconciles with rows.

---

## C7 (MEDIUM, still open) — token-detail "All-time PnL" contradicts "$0 invested"
ETH detail page: **All-time −$4.62 / −32.41%** next to **"Total invested $0.00 / Average buy price
—"**. For a connected/cost-unknown holding (`costTracked=false`, `avgCost=null`) this figure is a
**price return**, not the user's PnL — presenting a dollar "PnL" beside "$0 invested" is
contradictory. (The per-asset LIST endpoint already returns `pnlAllTime: 0` for these; only the
detail page still derives and shows the price-return PnL.)

**Fix (frontend, token-detail `[tokenSlug]`):** when `costTracked === false` / no cost basis, label
the figure **"1Y price return"** (or "Price change", matching the window) and drop the synthesized
dollar amount — or show "—" for All-time. Keep the real cost-basis PnL for manual/cost-tracked
holdings.

Validate: connected token detail shows a clearly-labelled price return (or "—"), never a "$X PnL"
next to "$0 invested"; cost-tracked holdings unchanged.

---

## A2 (LOW — note, decide separately) — synthetic token price charts shown as real
`backfill-snapshots.ts` writes a synthetic random-walk `token_price_snapshot` for tokens with no
CoinGecko mapping; the token-detail **price chart** then renders fabricated history as if real (ETH
is real/mapped; obscure auto-listed tokens like some held here may not be). If pursued: flag
synthetic series and suppress/label the chart for those tokens. Lower priority than A1/N3/H11.

## Out of scope for 78 (still open, different domain)
- **H13 — NFT spam:** still 56 NFTs incl. "Garbage Bags"/"Hefty Presents"; Moralis `possible_spam`
  under-flags. Needs a heuristic or better source. Track separately.

---

## Suggested order
N3 (kills the live −94% now) → A1 (stops re-introduction + data corruption) → D1 (honest "—") →
H11 chart/all-time → C7 → A2. N3+A1+D1 are the correctness core; H11 is the biggest but largest.

## Validate (suite)
- Existing-connected migration: a seeded portfolio with spaced backfill + a trailing daily run →
  backfill rows approx=true, daily run approx=false; 30d="—", 24h real.
- backfill script: re-run after a daily snapshot exists → real row's value preserved, approx stays
  false; script rows approx=true.
- D1: null propagates to "—"; totals==Σ rows with a null portfolio.
- C7: cost-unknown holding → labelled price return / "—".
- overview + analytics + snapshots + wallet-data suites green.
