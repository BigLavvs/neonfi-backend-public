# retrofit-44 — Editable saved opening positions (PATCH balance + cost)

## Why
retrofit-27 made opening positions immutable ("delete + re-add" was the only redo path). We're
lifting that: a saved starting asset can now be edited in place — its opening **balance** and/or
**cost basis** — from the "starting assets" editor (new-portfolio, onboarding, and the wallet Add
Asset modal share one UI). DELETE already exists and stays. This is the backend half.

`PATCH /portfolios/:portfolioId/assets/:id` already exists but only edits `netDeposit`
(`assets.service.ts:updateAsset`). Extend it to also accept an opening edit `{ balance, cost }` and
recompute the opening fields + recalc, mirroring `addAsset`.

## Changes

### 1. `src/modules/assets/assets.schemas.ts`
Export the existing `CostSchema` (currently file-local) and extend the update body. Keep `netDeposit`
for back-compat; add optional `balance` + `cost` for the opening edit.
```ts
// export the discriminated union so updateAsset can reuse the exact create-time cost contract
export const CostSchema = z.discriminatedUnion('mode', [CostAvgSchema, CostHistoricalSchema, CostNoneSchema]);

export const UpdateAssetBodySchema = z
  .object({
    netDeposit: z.string().regex(/^\d+(\.\d+)?$/, 'netDeposit must be a non-negative decimal string').optional(),
    // retrofit-44: opening edit — recomputes openingBalance/openingCostBasis/openingAt.
    balance: decimalStr.optional(),
    cost: CostSchema.optional(),
  })
  .strict()
  .refine((b) => b.netDeposit !== undefined || b.balance !== undefined || b.cost !== undefined, {
    message: 'Provide netDeposit, or balance/cost to edit the opening position',
  });
```

### 2. `src/modules/assets/assets.repository.ts`
Extend `updateAssetRow` to accept the opening columns too:
```ts
export async function updateAssetRow(
  assetId: number,
  data: { netDeposit?: string; openingBalance?: string; openingCostBasis?: string | null; openingAt?: Date | null },
): Promise<AssetWithToken> { /* prisma.asset.update({ where:{id}, data, include:{token:true} }) */ }
```
(Only set the keys that are present — Prisma ignores `undefined`, so spreading `data` straight through is fine.)

### 3. `src/modules/assets/assets.service.ts` → `updateAsset`
When `balance` or `cost` is present, treat it as an **opening edit**: recompute the opening fields
exactly like `addAsset`, write them, then recalc inside a transaction. The frontend always sends BOTH
`balance` and `cost` together on an opening edit, but be defensive: fall back to the existing values
for whichever is omitted.
```ts
export async function updateAsset(portfolio, assetId, body): Promise<AssetDTO> {
  assertManualPortfolio(portfolio);
  const existing = await findAssetById(assetId);
  if (!existing || existing.portfolioId !== portfolio.id) throw new AssetError(404, 'ASSET_NOT_FOUND', 'Asset not found');

  const isOpeningEdit = body.balance !== undefined || body.cost !== undefined;
  if (isOpeningEdit) {
    const balanceStr = body.balance ?? existing.openingBalance.toString();
    const balanceNum = Number(balanceStr);
    if (!(balanceNum > 0)) throw new AssetError(400, 'INVALID_BALANCE', 'Opening balance must be greater than 0');

    // Resolve cost → openingCostBasis/openingAt (same logic as addAsset). If `cost` omitted, keep the
    // existing per-unit avg and rescale to the new balance so a balance-only edit stays consistent.
    let openingCostBasis: string | null;
    let openingAt: Date | null;
    if (body.cost === undefined) {
      const prevBal = Number(existing.openingBalance.toString());
      const prevBasis = existing.openingCostBasis !== null ? Number(existing.openingCostBasis.toString()) : null;
      const perUnit = prevBasis !== null && prevBal > 0 ? prevBasis / prevBal : null;
      openingCostBasis = perUnit !== null ? (balanceNum * perUnit).toFixed(8) : null;
      openingAt = existing.openingAt;
    } else if (body.cost.mode === 'avg') {
      openingCostBasis = (balanceNum * Number(body.cost.avgCost)).toFixed(8);
      openingAt = null;
    } else if (body.cost.mode === 'historical') {
      const asOf = new Date(body.cost.date);
      const snap = await findTokenPriceSnapshotOnOrBefore(existing.tokenId, asOf);
      if (!snap) throw new AssetError(400, 'PRICE_HISTORY_UNAVAILABLE', 'No price history on or before the requested date — choose average or no cost', { date: body.cost.date });
      openingCostBasis = (balanceNum * snap.price).toFixed(8);
      openingAt = asOf;
    } else {
      openingCostBasis = null; // 'none'
      openingAt = null;
    }

    await prisma.$transaction(async (tx) => {
      await updateAssetRow(assetId, { openingBalance: balanceStr, openingCostBasis, openingAt }); // see note
      await recalcAssetBalance(tx, portfolio.id, existing.tokenId);
      await recalcPortfolioNetDeposit(tx, portfolio.id);
    }, { timeout: 15000 });
    await invalidatePnlCache(portfolio.id);
  } else if (body.netDeposit !== undefined) {
    await updateAssetRow(assetId, { netDeposit: body.netDeposit });
  }

  // DTO read AFTER commit (mirror addAsset): balance/avgCost/costBasis reflect the new opening.
  const fresh = await findAssetById(assetId);
  const allAssets = await findAllAssetsByPortfolioId(portfolio.id);
  const symbols = allAssets.map((a) => a.token.symbol);
  const [priceMap, changeMap] = await Promise.all([getLivePriceMap(symbols), getLiveChangeMap(symbols)]);
  const totalValue = computeTotalValue(allAssets, priceMap);
  return toAssetDTO(fresh!, totalValue, priceMap, changeMap);
}
```
**Note on the tx + repository:** `updateAssetRow` must run on the SAME `tx` client as the recalc (so
the row update + recalc are atomic). Either give `updateAssetRow` an optional `tx` param, or inline a
`tx.asset.update(...)` in the transaction and keep `updateAssetRow` for the non-tx netDeposit path.
Prefer adding an optional client param so there's one code path. Match however the existing repo
helpers thread the tx client (check `recalcAssetBalance`'s signature — it already takes `tx`).

Also update the `addAsset` header comment in `assets.service.ts` that says opening fields have "no
PATCH" — they do now (retrofit-44).

## Tests (`tests/assets*.test.ts`, mock nothing new — same DB harness)
- PATCH `{ balance, cost:{mode:'avg',avgCost} }` on an existing opening updates `openingBalance` +
  recomputes `costBasis` = balance×avgCost; DTO `balance`/`avgCost` reflect it; idempotent.
- PATCH `{ balance }` only → rescales cost basis at the prior per-unit avg (per-unit avgCost
  unchanged); `cost:{mode:'none'}` → avgCost null/costTracked false.
- PATCH `{ cost:{mode:'historical', date} }` with no snapshot → 400 PRICE_HISTORY_UNAVAILABLE.
- Ownership (other user's portfolio → 403/404) and connected-portfolio → 403 still hold.
- Existing netDeposit-only PATCH still works (back-compat).
- `tsc --noEmit` clean; suite green; `NODE_ENV=test`; dev stopped.

## Commit & run
Commit named files only: `src/modules/assets/assets.schemas.ts`, `assets.repository.ts`,
`assets.service.ts`, tests. Report SHA. No migration (columns already exist). Leave dev stopped.

## After it lands
`PATCH /portfolios/:id/assets/:assetId` with `{ balance, cost }` edits a saved starting asset in
place; the shared StartingAssetsEditor uses it for the wallet "Add Asset" modal's edit action.
