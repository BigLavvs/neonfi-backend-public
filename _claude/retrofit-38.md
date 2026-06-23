# retrofit-38 — Backfill the avg-cost model onto pre-retrofit-27 holdings

## Symptom (frontend, token analytics + wallet)
For existing holdings the analytics page shows **Average buy price “—”, Total invested “$0.00”,
all-time PnL “—”**, even though the wallet Transactions tab lists real **Bought** rows with USD
values (e.g. 23 ETH +$40,859, 0.5 BTC +$32,873) that exactly account for the balances. The frontend
is correct — it reads `asset.costTracked / avgCost / costBasis`; those are empty.

## Cause (to CONFIRM first — see check below)
retrofit-27 added the average-cost columns (`Asset.avgCost`, `costBasis`, `realizedPnl`) and
`recalcAssetBalance`, but recalc only runs on transaction create/update/delete. Assets + transactions
created **before** retrofit-27 were never recomputed, so their `avgCost`/`costBasis` stayed null/0 →
`costTracked` false → the “—” everywhere. (recalc itself is fine; there’s just no backfill.)

### Confirm before running (one-off, read-only)
For an affected portfolio, check an asset that has buy transactions:
- `Asset.avgCost` is null / `costBasis` = 0, AND
- its `buy` transactions have non-null `usdValue` and `direction = 'buy'`.
If avgCost is null while buys with usdValue exist → it’s the missing backfill (this retrofit). If the
holdings were instead added via Starting Assets with cost mode **“Don’t track cost”** (openingCostBasis
null, no buys), then “—” is CORRECT and expected — backfill will (correctly) leave them untracked.

## Change — a one-off, idempotent backfill
Add a script `src/scripts/backfill-costbasis.ts` (wire `npm run backfill:costbasis`) that recomputes
every asset from its real history using the EXISTING functions (no new cost logic):

```ts
// For determinism, process each (portfolioId, tokenId) asset; recalc + portfolio net-deposit run in
// one interactive transaction, reusing recalc.ts. Idempotent — safe to run repeatedly.
const assets = await prisma.asset.findMany({ select: { portfolioId: true, tokenId: true } });
let updated = 0;
for (const { portfolioId, tokenId } of assets) {
  await prisma.$transaction(async (tx) => {
    await recalcAssetBalance(tx, portfolioId, tokenId);
    await recalcPortfolioNetDeposit(tx, portfolioId);
  });
  updated++;
}
// Invalidate the derived PnL cache so the next read recomputes from the backfilled columns.
const ids = [...new Set(assets.map((a) => a.portfolioId))];
await Promise.all(ids.map((id) => redis.del(`portfolio_pnl:${id}`).catch(() => {})));
console.log(JSON.stringify({ event: 'costbasis_backfill_done', assets: updated, portfolios: ids.length }));
```

Notes:
- Reuse `recalcAssetBalance` / `recalcPortfolioNetDeposit` from `src/modules/transactions/recalc.ts`
  verbatim — do NOT duplicate cost logic. This guarantees the backfill matches live behavior exactly.
- Safe by construction: an asset whose history has no cost (opening lot with null cost + no priced
  buys) recomputes to `avgCost = null` (correctly stays untracked). One with priced buys gets the
  weighted `avgCost` + `costBasis`.
- Optional `--dry-run` flag: log `{symbol, before:{avgCost,costBasis}, after:{...}}` per asset without
  writing, so you can eyeball the diff first.

## Tests
- `tests/...recalc/backfill`: seed an asset with `avgCost = null`, `costBasis = 0` but two `buy`
  transactions with usdValue → after the backfill routine, `avgCost` = weighted average and
  `costBasis` = Σ buy usd; a cost-less opening-lot asset stays `avgCost = null`.
- `tsc --noEmit` clean; affected suites green, `NODE_ENV=test`, dev stopped.

## Commit & run
Commit named files only (`src/scripts/backfill-costbasis.ts`, `package.json` script, any test). Report
SHA. Then run `npm run backfill:costbasis` once against the dev DB and paste the
`costbasis_backfill_done` line. Leave dev stopped.

## After it lands
Re-open a token’s analytics: Average buy price, Total invested, and all-time PnL should populate for
holdings that have priced buys; the wallet badge (now the token’s 24h change — separate FE change)
is unaffected.
