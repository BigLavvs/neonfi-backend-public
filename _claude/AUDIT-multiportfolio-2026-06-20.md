# Multi-portfolio reconciliation test — 2026-06-20

Answers the question: **"will all these calculations hold up across multiple portfolios of
different types?"** Ran a LIVE test on the running app (account demo3, Pro) by spinning up 4
portfolios of mixed types, capturing the overview, reconciling every aggregate, then tearing the
test portfolios back down.

## Setup (live)
Baseline: 2 portfolios — "My main" (manual, 4 USDT) + "Portfolio 2" (connected, wallet
`0xcB1C…905`). Total $16.24 · tx 421 · all-time −$293.83.

Added two test portfolios:
- **TEST-M-tracked** (manual) — one cost-tracked buy: 0.001 BTC @ $50,000 cost.
- **TEST-C-readd** (connected) — the **same wallet** `0xcB1C…905` as Portfolio 2 (to exercise
  dedup + per-portfolio import).

## Result — every aggregate reconciles across the 4 mixed portfolios ✓
Fetched `/overview` (cache-busted via a fresh `days` key) → 4 portfolios:

| Portfolio | type | value | all-time | 24h |
|---|---|---|---|---|
| My main | manual | $4.00 | $0.00 | $0.00 |
| Portfolio 2 | connected | $12.24 | −$293.84 | +$0.02 |
| TEST-M-tracked | manual | $63.43 | +$13.43 | $0.00 |
| TEST-C-readd | connected | $12.24 | −$293.84 | **−$139.86** |

- **totalValue $91.90 == Σ rows $91.91** (1¢ rounding) ✓
- **allocation Σ $91.90 == total** ✓ (C2 holds at N=4)
- **tx 422 == 421 + 1** ✓ — TEST-C (same wallet) imported its **16 transfer rows**
  (per-portfolio hash, retrofit-74) but added **0** to the headline count (wallet deduped);
  only TEST-M's +1 buy incremented it. Same-wallet dedup **verified**.
- **all-time −$574.25 == Σ canonical rows** ✓ — manual cost-basis (My main $0, TEST-M +$13.43;
  +$13.43 = $63.43 now − $50 cost ✓) + connected snapshot (−$293.84 ×2). retrofit-75 canonical
  per-type **verified**.
- **24h −$139.83 == Σ rows −$139.84** ✓ (rounding) — totals == Σ rows even across the mix.
  retrofit-76 **verified**.

**Verdict on the question: the aggregation math is sound.** Value, allocation, transaction
count, all-time, and 24h all reconcile (totals == Σ per-portfolio) across 2 manual + 2 connected,
including a cost-tracked manual and a same-wallet re-add. Cleanup done: TEST-M (20) + TEST-C (21)
deleted; account back to 2 portfolios / $16.24 / tx 421.

## …but the test surfaced TWO real issues

### NEW — N1: a freshly-synced connected portfolio shows fake 24h/7d/30d  → retrofit-77
TEST-C and Portfolio 2 are the **same wallet at the same $12.24**, yet TEST-C's 24h is
**−$139.86** while Portfolio 2's is **+$0.02**. The only difference is the 24h **baseline**:
- Portfolio 2 has a REAL daily-job snapshot from 06-19 (~$12.22) → 24h ≈ +$0.02 (correct).
- TEST-C was created today, so it has NO real 06-19 snapshot. Its initial-sync **backfill** wrote
  approximate historical snapshots (Moralis net-worth-at-block; sync.ts itself flags older values
  as "APPROXIMATE — historical balance × ~today's price"). The nearest-to-24h-ago backfilled
  point is an inflated ~$152, so 24h = 12.24 − 152 = **−$139.86**.

So **any user who connects a wallet today immediately sees a wildly wrong 24h** (here −92% on a
$12 wallet) until real daily snapshots accumulate. The reconciliation still holds (the fake value
is consistently summed) — but the underlying number is wrong and very user-visible. Fix in
retrofit-77.

### Root cause it points back to — H11: connected historical values are approximate/inflated
The backfill that produced the bogus −$139.86 is the same approximate sampler behind **all** of a
connected portfolio's history — which feeds **all-time too**. TEST-C/Portfolio 2's all-time
baseline is ~$306 (−96%) on a wallet now worth $12; if that $306 is the same approximate inflation
(this wallet has sampled at $152 / $306 / earlier ~$2,934), then the −96% all-time is **also
overstated**, not just the 24h. retrofit-72 de-spammed the token list but did not fix the
approximate *pricing* of historical points. This is the single biggest remaining accuracy gap for
connected portfolios; retrofit-77 contains the honest short-term fix and flags the deeper
historical-pricing fix as the follow-on.

### Known edge — N2: same wallet in two portfolios double-counts VALUE (tx count dedups)
TEST-C + Portfolio 2 both count the same on-chain $12.24 → $24.48 in the total, and −$293.84 ×2
in all-time. Tx count dedups the wallet (retrofit-74) but value/all-time do not. Defensible (two
portfolios are two buckets) but **inconsistent** with the tx-count treatment. Edge case (same
wallet in two portfolios is unusual); noting, not fixing now.
