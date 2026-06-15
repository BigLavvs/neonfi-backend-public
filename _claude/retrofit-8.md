# Neonfi backend — retrofit-8: asset-add seeds an acquisition + atomic portfolio assets[] (C3b)

Commit 3b of the frontend-audit remediation (`_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `0c1ecf8` (retrofit-7).

Makes "add a manual asset" capture the holding the frontend collects (amount + price + date + notes) by
**seeding a native `buy` transaction** — so balance and cost-basis derive correctly (the model in recalc.ts),
one source of truth, accurate PnL via retrofit-7's `priceAtTime`. Same for atomic manual portfolio creation
with an `assets[]` array. No new Asset columns. Idowu signed off (see the C3 triage).

**Deliberate divergences (docx-fix pile):** `POST /portfolios/:id/assets` now accepts `{amount?, priceAtTime?, timestamp?, notes?}` and seeds a tx (architecture: asset create is `{tokenId}`); `POST /portfolios` manual now accepts `assets[]` (architecture: manual create is `{type,name}`).

## 0. Pre-verified state (re-verify before editing)

- `src/modules/assets/assets.schemas.ts:3-5` — `CreateAssetBodySchema = z.object({ tokenId }).strict()`.
- `src/modules/assets/assets.controller.ts:53-74` — POST safeParses then `addAsset(user.id, portfolio, body)`; ownership middleware sets `c.get('portfolio')` (34-47).
- `src/modules/assets/assets.service.ts:37-68` — `addAsset`: assertManualPortfolio, token lookup, plan-rank check (49-57, free → token.rank ≤ 10), existing-asset check (59-62), `createAssetRow({portfolioId, tokenId})` (64).
- `src/modules/assets/assets.repository.ts:26-31` — `createAssetRow` uses global `prisma` (need a tx-aware create for atomicity — use `tx.asset.create` inline).
- `src/modules/portfolios/portfolios.schemas.ts:10-14` — `ManualPortfolioSchema = z.object({type:'manual', name, startingBalance?}).strict()`.
- `src/modules/portfolios/portfolios.controller.ts:44-64` — POST safeParses then `createPortfolio(user.id, body)`. (Header comment 1-6 notes `assets` is currently strict-rejected — that's what we're changing.)
- `src/modules/portfolios/portfolios.service.ts:52-134` — `createPortfolio`: plan cap (56-65), slug check (67), manual branch (123-133) does `createPortfolioRow({..., startingBalance, netDeposit: startingBalance ?? '0'})`.
- `src/modules/transactions/transactions.service.ts:231-331` — `createTransactionFromWebhook` is the atomic "ensure-asset + create native/erc20 tx + recalc" pattern to mirror. Resolves type/direction rows via global prisma (237-240) then writes via the `tx` client. `computeUsdValue(symbol, amount, priceAtTime?)` is priceAtTime-aware after retrofit-7.
- `src/modules/transactions/transactions.repository.ts` — `createTransactionRow`/`createNativeDetail` accept a `tx` client (88-101). `recalc.ts` `recalcAssetBalance`/`recalcPortfolioNetDeposit` accept `tx` (14, 72).

## 1. Shared seeding helper [LOCKED] — `transactions.service.ts`
Transactions module owns Transaction, so the seed lives here; assets/portfolios call it (module isolation).
```ts
// Seeds a manual `native buy` acquisition: the Asset must already be created by the
// caller in the SAME tx. Resolves static seed rows via global prisma (low tx query
// count, like createTransactionFromWebhook), writes via the passed tx client.
export async function seedAcquisitionInTx(
  tx: Prisma.TransactionClient,
  params: { portfolioId: number; tokenId: number; symbol: string;
            amount: string; priceAtTime?: string; timestamp?: string; notes?: string | null },
): Promise<void> {
  const [typeRow, dirRow] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } }),
  ]);
  const usdValue = await computeUsdValue(params.symbol, params.amount, params.priceAtTime);
  const created = await createTransactionRow(tx, {
    portfolioId: params.portfolioId, typeId: typeRow.id, directionId: dirRow.id,
    timestamp: params.timestamp ? new Date(params.timestamp) : new Date(),
    notes: params.notes ?? null,
  });
  await createNativeDetail(tx, created.id, {
    amount: params.amount, symbol: params.symbol, usdValue,
    priceAtTime: params.priceAtTime ?? null,
  });
  await recalcAssetBalance(tx, params.portfolioId, params.tokenId);
  await recalcPortfolioNetDeposit(tx, params.portfolioId);
}
```
Manual entries are always `native` (the Token catalog has no contract address for erc20 detail; erc20/nft stay webhook-only).

## 2. Asset-add seeds the acquisition [LOCKED]
`assets.schemas.ts` — extend (keep `.strict()`):
```ts
export const CreateAssetBodySchema = z.object({
  tokenId: z.number().int().positive(),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  priceAtTime: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  timestamp: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict();
```
`assets.service.addAsset`: keep assertManualPortfolio + token lookup + plan-rank check + existing-asset check. Then, in one `prisma.$transaction`: `tx.asset.create({ data: { portfolioId, tokenId } })`; if `amount` is present and `> 0`, call `seedAcquisitionInTx(tx, { portfolioId, tokenId, symbol: token.symbol, amount, priceAtTime, timestamp, notes })`. After commit, invalidate the portfolio's derived cache (reuse the transactions cache-invalidation — export a small helper or call `portfolioDerivedCacheKeys` + `redis.del`). Return the AssetDTO (balance/netDeposit now reflect the seed). **amount omitted → just the asset at balance 0 (back-compat with existing `{tokenId}` tests).**

## 3. Atomic manual portfolio + assets[] [LOCKED]
`portfolios.schemas.ts` — `ManualPortfolioSchema` += optional `assets`:
```ts
assets: z.array(z.object({
  tokenId: z.number().int().positive(),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  priceAtTime: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  timestamp: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict()).max(50).optional(),
```
`portfolios.service.createPortfolio` manual branch: if `assets?.length`, run portfolio-create + all asset seeds in ONE `prisma.$transaction` (atomic): `tx.portfolio.create(...)`, then per asset — validate token exists, **per-asset plan-rank check (free → rank ≤ 10)**, reject duplicate tokenIds within the array, `tx.asset.create({portfolioId, tokenId})`, and if `amount>0` `seedAcquisitionInTx(tx, {...})`. Invalidate cache after commit. If no `assets`, keep the existing single-insert path unchanged.
- **netDeposit interaction:** seeding runs `recalcPortfolioNetDeposit` → portfolio.netDeposit becomes Σ asset cost-basis, overriding the `startingBalance`-derived value. The frontend sends either `startingBalance` OR `assets[]`, not both; if both arrive, assets win (document it). 

## 4. Scope
```
src/modules/assets/assets.schemas.ts            # extend CreateAssetBodySchema
src/modules/assets/assets.service.ts            # addAsset: atomic create + seed
src/modules/portfolios/portfolios.schemas.ts    # ManualPortfolioSchema += assets[]
src/modules/portfolios/portfolios.service.ts    # createPortfolio: atomic manual + assets[]
src/modules/transactions/transactions.service.ts# seedAcquisitionInTx (exported)
tests/assets.test.ts, tests/portfolios.test.ts  # new tests
```
No schema.prisma change / migration (no new columns — uses retrofit-7's). No frontend. No env.

## 5. Tests
- `POST /portfolios/:id/assets {tokenId, amount:'2', priceAtTime:'100'}` → asset created; one native buy tx seeded; `balance=2`, `netDeposit=200`; GET transactions shows it.
- `POST {tokenId}` only (no amount) → asset at balance 0, no transaction (existing tests stay green).
- Free user seeding a rank>10 token → 403 PLAN_LIMIT_REACHED (rank check still applies).
- `POST /portfolios {type:'manual', name, assets:[{tokenId:btc, amount:'1', priceAtTime:'30000'},{tokenId:eth, amount:'2', priceAtTime:'2000'}]}` → portfolio + 2 assets + 2 seed txs; portfolio.netDeposit = 34000; atomic (a bad asset rolls back the whole create).
- Duplicate tokenId in `assets[]` → 400/409, nothing created.
- Existing assets.test.ts strict-rejection test (`balance` field) still 400 — `balance` remains disallowed.

## 6. STOP-and-ask gates
1. If `addAsset`/`createPortfolio` becoming `$transaction`-wrapped collides with their current return-DTO flow (toAssetDTO/toPortfolioDTO read post-commit), keep the DTO read AFTER the commit — surface if it forces a bigger refactor.
2. `startingBalance` + `assets[]` both present: default is assets-win (recalc). If a test or the frontend expects otherwise, surface.
3. If seeding inside the portfolio `$transaction` risks Neon's P2028 timeout for large `assets[]`, the `.max(50)` cap bounds it; if it still trips, surface (don't silently drop the atomicity).

## 7. What NOT to do
- No new schema columns/migration (retrofit-7 added priceAtTime/notes already).
- Manual seeds are `native` only — don't try to construct erc20 detail (no contract address in the catalog).
- Don't change connected-portfolio or webhook flows. Don't touch PATCH/GET asset endpoints.
- No docx edits. No `git add -A`; leave stale `stage-14*.md` + `frontend-audit.md` untracked.

## 8. Commit and report
```bash
git add src/modules/assets/assets.schemas.ts src/modules/assets/assets.service.ts \
        src/modules/portfolios/portfolios.schemas.ts src/modules/portfolios/portfolios.service.ts \
        src/modules/transactions/transactions.service.ts \
        tests/assets.test.ts tests/portfolios.test.ts \
        _claude/retrofit-8.md
git commit -m "feat(assets,portfolios): asset-add seeds acquisition tx + atomic manual portfolio assets[] (retrofit-8)"
git log --oneline -3
```
Report: new SHA; demonstration that asset-add with amount seeds a buy tx and derives balance/netDeposit; atomic portfolio+assets[] (and rollback on a bad asset); back-compat `{tokenId}`-only path; full suite count; doc-fix items (asset-add body extension; manual `assets[]`). If blocked, output the question and STOP.
