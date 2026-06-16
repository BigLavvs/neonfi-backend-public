# retrofit-27: average-cost PnL + starting balances (opening positions) + auto-add asset on buy

Replaces the `netDeposit`-as-cost-basis model (`recalc.ts` / `derive.ts`) with per-asset **average cost**, adds **opening balances** (a starting position that is NOT a trade), and makes a user **buy auto-create** the asset. These interlock — land as ONE change. Folds in the former retrofit-26 Part B.

## 0. Why
Today PnL = `totalValue − netDeposit`, where `netDeposit = Σ(buy USD) − Σ(sell USD)` (`recalc.ts:9-10`). A sell subtracts full proceeds (not the cost of units sold), so realized gain pollutes the basis, the % is measured against a meaningless (sometimes ≤0) base, and accuracy depends on users typing `priceAtTime`. New model: per-asset average cost → meaningful unrealized + realized PnL; opening balances seed pre-existing holdings honestly (not as fake buys).

## 1. Schema (Prisma migration — `npx prisma migrate dev`)
Add to `Asset`:
- `openingBalance   Decimal  @default(0)`   // starting qty, same scale as `balance`
- `openingCostBasis Decimal?`              // total USD cost of the opening qty; NULL = "don't track cost"
- `openingAt        DateTime?`             // as-of date (for 'historical' cost mode)
- `realizedPnl      Decimal  @default(0)`  // cumulative realized PnL (USD), maintained by recalc

One opening position per asset is structural (it lives on the asset row). Opening fields are written ONLY at asset creation — there is **no update path** (immutable). `netDeposit` stops being the basis; leave the column unused (drop in a later cleanup). Backfill: dev data — set `openingBalance=0`, `openingCostBasis=null` on existing assets (their existing buy txns keep providing cost). Note in the migration that pre-existing seeded buys remain buys.

## 2. `recalc.ts` — balance + average cost + realized PnL
Replace the netDeposit loop. Process the asset's txns in **chronological** order, seeded by the opening lot:
```
qty          = openingBalance
costKnownQty = openingCostBasis != null ? openingBalance : 0
totalCost    = openingCostBasis ?? 0                  // USD basis of costKnownQty
realized     = 0
for tx in chronological(native + erc20, excl. NFTs, excl. transfers):
  price = Number(usdValue)/Number(amount)             // per-unit at tx time
  buy:  qty += amt; costKnownQty += amt; totalCost += amt*price
  sell:
    avg  = costKnownQty > 0 ? totalCost/costKnownQty : null
    if (avg != null) {
      sold      = min(amt, costKnownQty)
      realized += sold * (price - avg)
      costKnownQty -= sold
      totalCost    -= sold * avg
    }
    qty -= amt
avgCost   = costKnownQty > 0 ? totalCost/costKnownQty : null
costBasis = totalCost                                 // basis of currently-held cost-known units
```
Write `balance=qty`, `realizedPnl=realized` (and persist `avgCost`, `costBasis` if you add columns, else recompute in derive). Rules: cost-unknown units (null opening cost) are excluded from avg cost AND unrealized PnL; an all-unknown asset → `avgCost=null` → PnL N/A. Transfers stay net-zero. (Over-sell handling: see §6.)

## 3. `derive.ts` — portfolio PnL
- `totalValue = Σ(balance × livePrice)` (unchanged; live `price:<SYMBOL>` → seeded fallback).
- `unrealizedPnlValue = Σ over assets with avgCost!=null of heldQty × (livePrice − avgCost)`.
- `unrealizedPnlPct = unrealizedPnlValue / Σ(costBasis)` (0 when no cost basis).
- `realizedPnlValue = Σ asset.realizedPnl`.
- Replace the old `pnlAllTime*` fields: expose `unrealizedPnl{Value,Pct}` + `realizedPnlValue`; define **all-time = unrealized + realized** for the single headline number. Keep the 60s cache.
- 24h/7d/30d stay snapshot-based (unchanged).

## 4. DTOs (wire contract — report these to the frontend)
Add to `overview.dto` / `portfolios.dto` / `assets.dto`:
- per-asset: `avgCost`, `costBasis`, `unrealizedPnlValue`, `unrealizedPnlPct`, `realizedPnlValue`, and `costTracked: boolean` (false when avgCost null).
- per-portfolio + overview totals: `unrealizedPnlValue`, `unrealizedPnlPct`, `realizedPnlValue`, `allTimePnlValue` (= unrealized + realized).
Round to the existing wire scale. Keep field names stable — the frontend wires to them.

## 5. Opening balance — rework `addAsset` (POST /portfolios/:id/assets)
Create a STARTING position, not a buy:
- Body: `{ tokenId, balance: Decimal(>0), cost: { mode: 'avg' | 'historical' | 'none', avgCost?: Decimal, date?: ISO } }`.
  - `avg`        → `openingCostBasis = balance × avgCost`, `openingAt = null`.
  - `historical` → price = nearest `TokenPriceSnapshot` on/before `date`; **none available → 400 `PRICE_HISTORY_UNAVAILABLE`** (so the user picks avg/none); `openingCostBasis = balance × price`, `openingAt = date`.
  - `none`       → `openingCostBasis = null`.
- Free-tier rank gate unchanged (free → token rank null or >10 → 403 `PLAN_LIMIT_REACHED`).
- One-per-asset: existing asset → 409 `ASSET_ALREADY_EXISTS`.
- Immutable: no PATCH of opening fields. Asset DELETE stays (clears everything = the redo path).
- Remove the old `amount`/`priceAtTime` seed-a-buy params — acquisitions now go through New Transaction → Buy.

## 6. Auto-add asset on a user `buy` (former retrofit-26 B)
In `createTransaction`, when `direction==='buy'` and the asset is absent → auto-create it (`openingBalance=0`, `openingCostBasis=null` — a pure trade), apply the free-tier rank gate, then proceed (the buy sets cost via §2). Keep `ASSET_NOT_IN_PORTFOLIO` for **sell/transfer** of an unheld token. **Decision adopted:** reject a sell exceeding holdings → 400 `INSUFFICIENT_BALANCE` (no negative balances). Flag if you'd rather keep the MVP negative-allowed behavior.

## 7. Tests
- `recalc`: opening(qty,cost)+buy+sell sequences → correct `avgCost`/`realized`/`balance`; null-cost opening excluded; all-unknown → avgCost null; oversell → 400.
- `derive`: unrealized/realized correct; null-cost asset → PnL N/A; %-base div-by-zero guarded.
- opening endpoint: avg / historical / none; historical w/o snapshot → 400; duplicate → 409; free rank gate.
- buy auto-add: new-token buy → asset created + cost set; sell/transfer unheld → 400.
- Update overview/portfolio/asset DTO tests for the new fields; remove old netDeposit-PnL assertions.

## 8. Gate + commit
Apply the migration, then `npx vitest run` the **transactions, portfolios, assets, overview, analytics, snapshots** suites green (DATABASE_URL_TEST set, dev stopped). Commit named files (no -A), one commit:
```
feat(pnl): average-cost basis + opening balances (starting positions) + auto-add asset on buy (retrofit-27)
```
Report SHA + the final DTO field names so I can wire the frontend.
