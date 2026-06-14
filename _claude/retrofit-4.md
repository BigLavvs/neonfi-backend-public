# Neonfi backend — retrofit-4: Analytics decimal rounding

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `0bfb977` (Stage 14).

The three analytics endpoints currently return raw JS-float derivations — e.g. `allTimePnlPct: 16.250000000000004`, `portfolioPercentage: 6.4408602...`. Round every numeric analytics output to a fixed **2-decimal-place** scale on the backend so the wire carries clean values that match the architecture reps. Decision owner: Idowu (round server-side, 2dp; the helper has a `dp` knob if 3dp is ever wanted).

## 0. Pre-verified state — what I read before writing this

Anchored against the committed Stage 14 files (`0bfb977`). Re-read each before editing — fresh state can drift.

- `src/modules/analytics/analytics.service.ts:80–90` — `buildSummary` returns 8 raw numeric fields: `allTimePnlPct`/`allTimePnlValue` (from `computeDerived`), `totalDeposits`/`totalWithdrawals` (from `getDepositWithdrawalTotals`), `pnl7d`/`pnl7dValue`/`pnl30d`/`pnl30dValue` (from `computePnlPeriod`). All raw floats.
- `src/modules/analytics/analytics.service.ts:93–102` — `buildPerformance` maps `value: Number(s.value.toString())` (raw Decimal→float).
- `src/modules/analytics/analytics.service.ts:104–123` — `buildHoldings` computes `value = balance * price` and `portfolioPercentage = (value / totalValue) * 100`, then `.sort((a,b) => b.value - a.value)`. Both raw floats.
- `src/modules/analytics/analytics.service.ts:34–48` — `withCache` wraps each `build*`. Rounding **inside** `build*` means the cached payload is already rounded (correct — round before cache, no separate invalidation needed).
- `src/modules/analytics/analytics.dto.ts:32–37` — `HoldingsDTO` comment says `portfolioPercentage` is "0-100 unrounded (frontend rounds for display)". This comment must change.
- Architecture reps (`architecture.txt:642–669`) show fixed precision: money 2dp (`1233.37`, `8900.00`, `9800.00`, `4469.00`), pct 1dp (`13.8`, `2.1`). 2dp on the wire is faithful and a superset of the doc's precision.
- `tests/analytics.test.ts` (326–337) assert with `toBeCloseTo` / `≈` against values already at ≤2dp (`16.25`, `9.41`, `93.56`, `6.44`) — 2dp rounding leaves them green.

## 1. Change

### 1.1 Add a `round` helper [LOCKED]
In `analytics.service.ts`, near `CACHE_TTL_S`:
```ts
/**
 * Round a derived analytics metric to a fixed wire scale. These values are JS-float
 * derivations (Number(decimal) + arithmetic) that carry representation noise
 * (e.g. 16.250000000000004); 2dp matches the architecture reps and hands the frontend
 * clean numbers to format. `dp` is the single knob — bump the default to 3 for finer
 * percentage granularity (Idowu's call).
 */
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
```

### 1.2 Apply in all three `build*` functions [LOCKED]

**`buildSummary` return** — wrap each of the 8 numeric fields; `portfolioId` stays an int:
```ts
  return {
    portfolioId,
    allTimePnlPct: round(derived.pnlAllTime),
    allTimePnlValue: round(derived.pnlAllTimeValue),
    totalDeposits: round(totalDeposits),
    totalWithdrawals: round(totalWithdrawals),
    pnl7d: round(pnl7d),
    pnl7dValue: round(pnl7dValue),
    pnl30d: round(pnl30d),
    pnl30dValue: round(pnl30dValue),
  };
```

**`buildPerformance`** — round each snapshot value:
```ts
    snapshots: snapshots.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: round(Number(s.value.toString())),
    })),
```

**`buildHoldings`** — sort on the **precise** value, then round in a final map (so 2dp ties can't reorder):
```ts
  const items = assets
    .map((a) => ({
      symbol: a.token.symbol,
      balance: Number(a.balance.toString()),
      price: Number(a.token.currentPrice.toString()),
    }))
    .filter((a) => a.balance > 0)
    .map((a) => {
      const value = a.balance * a.price;
      const portfolioPercentage = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return { symbol: a.symbol, value, portfolioPercentage };
    })
    .sort((a, b) => b.value - a.value)
    .map((a) => ({
      symbol: a.symbol,
      value: round(a.value),
      portfolioPercentage: round(a.portfolioPercentage),
    }));
```

### 1.3 Update the DTO comments [LOCKED]
`analytics.dto.ts`: change the `HoldingsDTO` comment "0-100 unrounded (frontend rounds for display)" → "0-100, rounded to 2dp (retrofit-4)". Add one line to the file header: "All numeric outputs are rounded to 2 decimal places on the wire (retrofit-4); see `analytics.service.ts` `round`."

## 2. Scope
```
src/modules/analytics/analytics.service.ts   # EDIT — round helper + apply in 3 build*
src/modules/analytics/analytics.dto.ts       # EDIT — comments only
tests/analytics.test.ts                      # EDIT — add test 338; confirm 326-337 green
_claude/retrofit-4.md                        # NEW
```
No schema, migration, env, or cache-logic changes. **Do NOT touch `derive.ts`** (see §4 gate 2).

## 3. Tests
- Run `tests/analytics.test.ts`. Confirm 326–337 still green — 2dp rounding preserves the documented expected values. If any **exact** (`toBe`) assertion breaks, it broke because the value was a raw float; update it to the 2dp value — do NOT loosen the matcher.
- **Add test 338 — rounding is applied**: seed a portfolio with three assets of **equal** USD value (e.g. three tokens whose `balance × currentPrice` are all equal). Assert each `portfolioPercentage === 33.33` exactly (not `33.33333…`), proving the round helper is wired. Also assert one summary pct field equals its own 2dp-rounded value. Target count: **338**.
- For the full suite, use the per-file pattern from the Stage 14 run (Neon dev DB drops on long serialized runs — retry only on the "reach database server" marker, never on a real assertion failure).

## 4. STOP-and-ask gates
1. If 2dp rounding changes holdings **sort order** in any existing test (a tie at 2dp), keep the sort on the precise value (§1.2 sorts before the rounding map) — don't sort on rounded values.
2. **Out of scope: `derive.ts`.** It feeds BOTH the analytics summary (rounded here, in the DTO mapping) AND `GET /portfolios` (still raw). This retrofit rounds only the analytics wire. If Idowu wants the portfolio-list derived fields (`totalValue`, `pnlAllTime`, `pnl24h`, …) rounded too, that's a separate retrofit — flag it, do NOT expand scope here.
3. If a `toBeCloseTo` assertion was secretly relying on >2dp precision (none should), surface it rather than papering over.

## 5. What NOT to do
- No DTO shape/field-name changes — the wire still matches the architecture rep, only precision changes.
- No rounding in `derive.ts`, snapshots, transactions, or assets services.
- No change to `withCache`, the cache keys, or invalidation.
- No schema / migration / env changes.
- No editing docx files; no `git add -A`; leave stale `stage-14.md` / `stage-14-v2.md` untracked.

## 6. Commit and report
```bash
git add src/modules/analytics/analytics.service.ts \
        src/modules/analytics/analytics.dto.ts \
        tests/analytics.test.ts \
        _claude/retrofit-4.md
git commit -m "fix(analytics): round derived outputs to 2dp on the wire (retrofit-4)"
git log --oneline -3
```
Report:
- New commit SHA.
- A `/summary` and a `/holdings` sample showing 2dp values (no float tails).
- Test 338 green + 326–337 still green (full count 338).
- grep proof that `derive.ts` is untouched (`git diff --stat 0bfb977 HEAD` shows only the 3 analytics-area files + the prompt).
- Anything unexpected. If blocked: output the question, stop, wait. Do not invent.
