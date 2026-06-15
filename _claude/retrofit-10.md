# Neonfi backend — retrofit-10: cross-portfolio transfer (C4b)

Commit 4b (final backend commit) of the frontend-audit remediation (`_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `08ff2db` (retrofit-8); retrofit-9 (NFT owner) is
independent and may land before or after.

Moves an asset between two of a user's **manual** portfolios as a **paired transaction** that produces real
PnL (Idowu's choice). Source gets a `sell` leg, dest a `buy` leg, sharing a `transferGroupId`; the dest
**inherits the source's per-unit cost basis** so the move conserves total basis and creates no fake PnL.
Reuses `recalc.ts` unchanged (sell/buy already move balance + netDeposit). The existing `transfer` direction
stays a no-op (the address-transfer sub-mode is out of scope, per the C4b triage).

**Deliberate divergences (docx-fix pile):** new `Transaction.transferGroupId`; new `POST /portfolios/:id/transactions/transfer`; cross-portfolio transfer is a concept absent from the architecture.

## 0. Pre-verified state (re-verify before editing)

- `src/modules/transactions/transactions.controller.ts:19-40` — router mounted at `/portfolios/:portfolioId/transactions`; `requireAuth` + ownership middleware sets `c.get('portfolio')` (the SOURCE). POST `''` (46-66), DELETE `'/:id'` (165-180). Add POST `'/transfer'` here (distinct path; no conflict with POST `''`).
- `src/modules/transactions/transactions.service.ts` — `createTransaction` (110-216) and `createTransactionFromWebhook` (231-331, the atomic ensure-asset+tx+recalc pattern, incl. `tx.asset.create` auto-create at 265-273). `invalidatePnlCache` is **exported** (retrofit-8). `recalcAssetBalance`/`recalcPortfolioNetDeposit` imported from recalc.ts. `seedAcquisitionInTx` (retrofit-8) shows the tx-client write pattern.
- `src/modules/transactions/recalc.ts:14-67` — `balance = Σbuy−Σsell amount`; `netDeposit = Σbuy−Σsell usdValue`; `transfer` is a no-op. So a `sell` leg drops balance+netDeposit, a `buy` leg raises them — exactly what we want.
- `src/modules/transactions/transactions.repository.ts:77-93` — `createTransactionRow(tx, data)`; add `transferGroupId?` to `CreateTransactionData`. `deleteTransactionRow` (181-183). `findTransactionById` (39-44) includes type/direction/details.
- `src/modules/transactions/transactions.service.ts:541-573` — `deleteTransaction`: loads tx, deletes, recalcs the one portfolio. Must be extended to delete BOTH legs when `transferGroupId` is set.
- `src/modules/transactions/transactions.dto.ts:20-42` — `TransactionListDTO`; add `transferGroupId`. `toTransactionListDTO` (68-100).
- `src/modules/assets/assets.repository.ts:16-24` — `findAssetByPortfolioToken(portfolioId, tokenId)` → AssetWithToken (has `balance`, `netDeposit`, `token`).
- `src/modules/portfolios/portfolios.repository.ts` — `findPortfolioById(id)` → PortfolioWithRelations (for dest validation).
- `prisma/schema.prisma` Transaction (292-331 post-retrofit-7): no `transferGroupId`. `transactionHash` is `@unique` but nullable — transfer legs leave it null (no conflict). `node:crypto` `randomUUID` is available.

## 1. Schema delta [LOCKED] — NOTE comment; Idowu owns the docx
```prisma
// Transaction
transferGroupId String? @db.VarChar(36)  // retrofit-10: links the two legs of a cross-portfolio transfer (sell in source, buy in dest). Null for all non-transfer txns.
// + @@index([transferGroupId])
```
One migration (Neon dev DB). Nullable; existing rows unaffected.

## 2. Endpoint + schema [LOCKED]
`transactions.schemas.ts`:
```ts
export const TransferBodySchema = z.object({
  destPortfolioId: z.number().int().positive(),
  symbol: z.string().min(1).max(20),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  timestamp: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict();
export type TransferBody = z.infer<typeof TransferBodySchema>;
```
`transactions.controller.ts`: `router.post('/transfer', ...)` — safeParse `TransferBodySchema`, `portfolio = c.get('portfolio')` (source), call `createCrossPortfolioTransfer(portfolio, body)`, return `201 { transfer: {...} }`. Map TransactionError as the other routes do.

## 3. Service — `createCrossPortfolioTransfer(source, body)` [LOCKED]
1. `assertManualPortfolio(source)` (connected are webhook-only).
2. Resolve dest: `findPortfolioById(body.destPortfolioId)` → must exist, `userId === source.userId`, be `manual`, and `!== source.id`. Else `TransactionError(400/403, ...)`. (`DEST_NOT_FOUND` / `INVALID_TRANSFER_TARGET`.)
3. Resolve token by `symbol` → 400 `UNKNOWN_TOKEN_SYMBOL` if missing.
4. Source asset: `findAssetByPortfolioToken(source.id, token.id)`. Require it exists and `balance >= amount` → else 400 `INSUFFICIENT_BALANCE`.
5. **Cost basis carry:** per-unit basis = `sourceAsset.netDeposit / sourceAsset.balance` (guard balance>0). `usdValue = (amount × netDeposit / balance).toFixed(8)`. Both legs use this same usdValue → source loses exactly that basis, dest gains it (total conserved, no fake PnL).
6. `transferGroupId = randomUUID()`. In ONE `prisma.$transaction`:
   - Ensure dest asset exists (`tx.asset.findUnique`… else `tx.asset.create({portfolioId: dest.id, tokenId, balance:'0', netDeposit:'0'})` — mirror the webhook auto-create). (Dest plan-rank is NOT re-checked: the user already holds the token in source; document it.)
   - Resolve `native` type + `sell`/`buy` direction rows (via global prisma, like seedAcquisitionInTx).
   - Source leg: `createTransactionRow(tx, {portfolioId: source.id, typeId: native, directionId: sell, timestamp: ts??now, notes, transferGroupId})` + `createNativeDetail(tx, id, {amount, symbol, usdValue, priceAtTime: null})`.
   - Dest leg: same with `directionId: buy`, `portfolioId: dest.id`, same `transferGroupId`.
   - `recalcAssetBalance(tx, source.id, tokenId)` + `recalcPortfolioNetDeposit(tx, source.id)`; same for dest.
7. After commit: `invalidatePnlCache(source.id)` and `invalidatePnlCache(dest.id)`.
8. Return both leg DTOs (`{ transferGroupId, source: <detailDTO>, dest: <detailDTO> }`).

## 4. Delete deletes the pair [LOCKED]
Extend `deleteTransaction`: after loading the tx, if `existing.transferGroupId !== null`, find BOTH legs (`prisma.transaction.findMany({where:{transferGroupId}})`), and in one `$transaction` delete both, then recalc the affected token in BOTH portfolios + `recalcPortfolioNetDeposit` for both. Invalidate both caches. (Both legs belong to the same user, so deleting via either portfolio is authorized — the source-portfolio ownership middleware already gates the request.) Non-transfer txns keep the existing single-leg path.

## 5. DTO
`TransactionListDTO` += `transferGroupId: string | null`; `toTransactionListDTO` → `transferGroupId: tx.transferGroupId ?? null`. (Lets the frontend group/label the two legs as a transfer.)

## 6. Scope
```
prisma/schema.prisma + prisma/migrations/<new>     # Transaction.transferGroupId + index
src/modules/transactions/transactions.schemas.ts   # TransferBodySchema
src/modules/transactions/transactions.controller.ts# POST /transfer
src/modules/transactions/transactions.service.ts   # createCrossPortfolioTransfer + delete-pair
src/modules/transactions/transactions.repository.ts# createTransactionRow transferGroupId param
src/modules/transactions/transactions.dto.ts       # transferGroupId on the DTO
tests/transactions.test.ts                         # new tests
```
No frontend (the transfer endpoint wiring + `endpoints.ts` entry are in the frontend pass). No NFT/webhook/connected changes.

## 7. Tests
- Transfer happy path: source 2 BTC @ basis 30000/unit (netDeposit 60000); transfer 1 BTC to dest → source balance 1 / netDeposit 30000; dest balance 1 / netDeposit 30000; two legs share `transferGroupId`; source leg `direction=sell`, dest `direction=buy`; **total basis conserved (60000), no fake PnL**.
- Insufficient balance (transfer 5 of 2 held) → 400 INSUFFICIENT_BALANCE, nothing written.
- Dest not owned / not found → 403/400; dest connected → 400; dest === source → 400. Source connected → 403.
- Delete one leg → BOTH legs gone; both portfolios' balances/netDeposit recalced; both caches cleared.
- DTO surfaces `transferGroupId` (null for ordinary txns).

## 8. STOP-and-ask gates
1. **Delete-pair cross-portfolio recalc** (§4) is the trickiest part — if deleting across two portfolios in one `$transaction` + dual recalc fights the existing `deleteTransaction` shape, surface rather than half-implement.
2. Cost-basis division precision (`amount × netDeposit / balance`): if rounding makes the conserved-basis test flaky, surface (use Decimal-safe arithmetic / `.toFixed(8)`).
3. Dest plan-rank: default is NOT re-checked (user already owns the token). If a test/spec expects enforcement, surface.
4. If `randomUUID` collides with the `transactionHash @unique` constraint usage (it shouldn't — different column, transfer legs leave `transactionHash` null), surface.

## 9. What NOT to do
- Don't change the existing `transfer` direction's no-op (address-transfer sub-mode stays as-is).
- Don't touch connected/webhook flows, NFTs, PATCH transaction.
- Manual transfer legs are `native` only. No docx edits. No `git add -A`; leave stale `stage-14*.md` + `frontend-audit.md` untracked.

## 10. Commit and report
```bash
git add prisma/schema.prisma prisma/migrations \
        src/modules/transactions/transactions.schemas.ts \
        src/modules/transactions/transactions.controller.ts \
        src/modules/transactions/transactions.service.ts \
        src/modules/transactions/transactions.repository.ts \
        src/modules/transactions/transactions.dto.ts \
        tests/transactions.test.ts \
        _claude/retrofit-10.md
git commit -m "feat(transactions): cross-portfolio transfer (paired legs, cost-basis carried) (retrofit-10)"
git log --oneline -3
```
Report: new SHA; a transfer demo showing both legs, the shared `transferGroupId`, conserved total cost basis (no fake PnL), and balances moved; delete-pair behavior; full suite count; doc-fix items (Transaction.transferGroupId; new transfer endpoint; cross-portfolio transfer concept). If blocked, output the question and STOP.
