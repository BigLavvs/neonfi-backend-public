# retrofit-77 — Fresh-sync connected portfolios show fake 24h/7d/30d (N1, from the multi-portfolio test)

Found in the live multi-portfolio reconciliation test (AUDIT-multiportfolio-2026-06-20.md). Real,
user-visible the moment a user connects a wallet.

## Symptom (proven live)
Two connected portfolios on the **same wallet** `0xcB1C…905`, both currently worth **$12.24**:
- "Portfolio 2" (synced days ago) → 24h **+$0.02** ✓
- "TEST-C-readd" (synced today) → 24h **−$139.86** ✗  (≈ −92% on a $12 wallet)

The aggregate still reconciles (totals == Σ rows), so this isn't a summation bug — the underlying
per-portfolio 24h value is simply wrong for a freshly-synced portfolio.

## Root cause
24h/7d/30d are `currentValue − findSnapshotNearDaysAgo(portfolioId, N)` (derive.ts, shared
`computeShortTermDeltas` after retrofit-76). On a wallet synced today there is **no real daily-job
snapshot** at 24h/7d/30d-ago, so `findSnapshotNearDaysAgo` falls back (within the H5 tolerance) to
a **backfilled** snapshot. Backfill values come from Moralis net-worth-at-block and are
approximate — sync.ts already says so: older points are "APPROXIMATE (historical balance ×
~today's price)". For this wallet the nearest-to-24h-ago backfilled point is an inflated ~$152, so
24h = 12.24 − 152 = −$139.86. Portfolio 2 avoids this only because it has accumulated a REAL
06-19 daily snapshot (~$12.22) that wins the nearest-match.

**Net: every connected portfolio shows garbage 24h (and 7d/30d) for its first day/week/month,
until real daily snapshots accumulate.** Bad first impression and misleading.

## Fix — never use an approximate (backfilled) snapshot as a SHORT-TERM baseline
Short-term PnL is read as precise recent performance; it must rest on real observed snapshots, not
the backfill estimate.

1. **Mark snapshot provenance.** Add to `BalanceSnapshot`:
   ```prisma
   approx Boolean @default(false)   // true = backfilled estimate (Moralis net-worth-at-block)
   ```
   - Set `approx: true` for every row written by the initial-sync backfill
     (`buildConnectedSnapshots`/`backfillConnectedSnapshots` in sync.ts).
   - Set `approx: false` for the daily snapshot job and the live "today" stitch (real, observed).
2. **Short-term baseline ignores approx rows.** In the snapshot lookup used by
   `computeShortTermDeltas` (24h/7d/30d), filter to `approx = false` when selecting the
   near-N-days-ago snapshot. No real snapshot within tolerance → return **0 / null**, which the
   frontend already renders as "—" (do NOT fall back to an approx point).
   - Result: a wallet connected today shows 24h/7d/30d = "—" until it has real snapshots at those
     ages; thereafter it shows true deltas. Portfolio 2 is unaffected (it has real snapshots).
3. **Existing rows:** you cannot retroactively tell which old rows were backfilled. Safe default —
   leave existing rows `approx=false` (portfolios that have been around already have real daily
   snapshots winning the match, as Portfolio 2 shows). Only NEW syncs get the correct flag. If you
   want to be strict, mark as `approx=true` any snapshot whose `createdAt` is within the same
   minute as the portfolio's `connectedAt` (the backfill batch).

## Deeper issue this exposes — H11: connected HISTORICAL VALUES are approximate/inflated
The same backfill estimate feeds **all-time** too. This wallet's all-time baseline is ~$306
(−96%) while it now holds $12; the wallet has sampled at $152 / $306 / earlier ~$2,934 — i.e. the
historical *pricing* is unreliable, so the −96% all-time is likely **overstated**, not just the
24h. retrofit-72 de-spammed the token *list* but did not fix approximate historical *pricing*.
Step 2 above stops the worst (short-term) damage immediately. The complete fix is one of:
- (a) value historical snapshots with **real historical prices at each block** (per-token
  historical price lookups), not today's price — accurate but more API cost; or
- (b) if real history isn't available, **label connected all-time as approximate** ("since
  connected, estimated") so the % isn't presented as exact.
Pick one as a follow-on (retrofit-78). Not blocking, but it's the biggest remaining accuracy gap
for connected portfolios.

## Validate
- Connect a wallet → its 24h/7d/30d show "—" immediately (not a huge fake number); after the daily
  job runs, 24h becomes a real delta.
- Same wallet in an older portfolio (real snapshots) still shows the correct small 24h.
- `totals.pnl24hValue === Σ per-portfolio pnl24hValue` still holds (a "—"/0 portfolio is excluded
  from both sides, per retrofit-75 M16).
- overview + analytics + portfolios suites green; add: a connected portfolio whose only ≤N-day
  snapshots are `approx=true` reports 24h/7d/30d = 0/— (not the approx delta).
