# retrofit-75 — Honest aggregate PnL: 24h phantom-gain + manual all-time (re-audit findings M16, R39)

Found during the post-retrofit-74 deep re-audit. Both are real, user-visible on the dashboard.

## M16 — totals 24h PnL counts a portfolio with no 24h-ago snapshot as pure gain
`overview.service.ts` (~300-308) computes:
```
for (const s of snaps24hAgo) { if (s) { value24hAgo += s.value; has24hBaseline = true; } }
const pnl24hValue = has24hBaseline ? totalValue - value24hAgo : 0;
```
`totalValue` is the CURRENT total of ALL portfolios, but `value24hAgo` only sums the portfolios that HAVE a
~24h-old snapshot. A portfolio with no 24h-ago snapshot (e.g. the manual "My main", created after that
point) is in `totalValue` but not in `value24hAgo`, so its whole current value reads as a 24h gain.
**Observed:** totals 24h = +$4.04 / +33% while the per-portfolio 24h sums to +$0.04 (manual 0 + connected
$0.04) — the extra +$4.00 is the manual portfolio's full value.

**Fix:** restrict the 24h delta to the portfolios that have a baseline, on BOTH sides:
```
let value24hAgo = 0, valueNowWithBaseline = 0, has24hBaseline = false;
snaps24hAgo.forEach((s, i) => {
  if (!s) return;                                   // no 24h-ago snapshot → exclude this portfolio
  has24hBaseline = true;
  value24hAgo += Number(s.value.toString());
  valueNowWithBaseline += derivedList[i].totalValue; // its CURRENT value (parallel array)
});
const pnl24hValue = has24hBaseline ? valueNowWithBaseline - value24hAgo : 0;
const pnl24h = has24hBaseline && value24hAgo > 0 ? (pnl24hValue / value24hAgo) * 100 : 0;
```
Now totals 24h == sum of the portfolios that actually have a 24h baseline (≈ +$0.04 here), never a phantom
gain. (Same idea would apply to any 7d/30d aggregate if one is added later.)

## R39 — manual portfolio shows +33% all-time on a stablecoin (cost-unknown opening)
"My main" = 4 USDT, `netDeposit` = $3, so `pnlAllTimeValue = value − netDeposit = +$1 / +33%`. The 4th USDT
is a **cost-unknown opening** (mode='none', `openingCostBasis` null), so retrofit-69 correctly leaves it
out of `netDeposit` — but its value is still in `totalValue`, creating a phantom gain. A stablecoin-only
portfolio should read ≈0%.

The honest all-time differs by portfolio type, and derive.ts already computes both:
- **connected** (no cost basis) → `pnlAllTimeValue` (snapshot-vs-baseline). ✓ already used.
- **manual** (has cost basis) → `allTimePnlValue` (unrealized + realized), which EXCLUDES cost-unknown
  holdings (avgCost null) → a stablecoin nets ~0, no phantom.

**Fix:** expose ONE canonical all-time per portfolio and use it everywhere (the frontend already reads
`pnlAllTimeValue`/`pnlAllTime`, so make those canonical in the overview DTO + totals):
- per-portfolio DTO: `pnlAllTimeValue = type==='connected' ? d.pnlAllTimeValue : d.allTimePnlValue`;
  `pnlAllTime = type==='connected' ? d.pnlAllTime : d.unrealizedPnlPct`.
- totals: `pnlAllTimeValue = Σ(canonical per portfolio)`; recompute `pnlAllTime` over the implied base
  (Σ baseline). Connected stays −96%; manual becomes ~0%; the aggregate stays ≈ −94.7%.
(Alternative if you prefer value−netDeposit everywhere: make a cost-unknown opening contribute its CURRENT
value to netDeposit so it nets 0 — but the canonical-per-type approach reuses derive's existing,
test-covered cost-basis math and is cleaner.)

## Validate
- Dashboard 24h PnL == sum of per-portfolio 24h (no phantom from a portfolio lacking a 24h baseline);
  a brand-new portfolio doesn't spike the 24h.
- Manual stablecoin-only portfolio → all-time ≈ 0% (not +33%); connected still −96%; aggregate ≈ −94.7%.
- overview + analytics suites green; add: (a) totals.pnl24hValue === Σ per-portfolio pnl24hValue when one
  portfolio has no 24h snapshot; (b) a USDT-only manual portfolio reports ~0 all-time.
