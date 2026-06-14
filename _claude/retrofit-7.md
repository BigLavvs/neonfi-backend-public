# Neonfi backend — retrofit-7: Transaction priceAtTime → usdValue + notes (C3a)

Commit 3a of the frontend-audit remediation (`_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `09782a9` (retrofit-6).

C3 was split: **C3a (this)** lays the accurate-PnL + notes foundation on transactions; **C3b (retrofit-8, next)**
makes asset-add seed an acquisition transaction. After C3a the existing two-call flow (add asset `{tokenId}` →
log buy) already works with accurate PnL because `priceAtTime` is an optional override.

**Deliberate divergences (Idowu signed off; docx-fix pile):** `Transaction.notes`, detail `priceAtTime`, and —
the big one — `usdValue` for manual buy/sell flips from *current price at write-time* (locked Option a) to
*entered price*. Webhook/connected transactions are unchanged (still current price).

## 0. Pre-verified state (re-verify before editing)

- `prisma/schema.prisma`: Transaction (292-321, no `notes`), NativeTransactionDetail (339-354, `usdValue` NOT NULL from retrofit-2), Erc20TransactionDetail (356-372, same). NftTransactionDetail (374-384) has no amount/usdValue.
- `src/modules/transactions/usd-value.ts:25` — `computeUsdValue(symbol, amount)`: Redis `price:<SYMBOL>` → `Token.currentPrice` → `0`; returns `toFixed(8)`. Header NOTE (11-14) declares current-price "LOCKED (retrofit-2)" — must be updated.
- `src/modules/transactions/recalc.ts:36-60` — `netDeposit = Σ(buy usdValue) − Σ(sell usdValue)`; reads `detail.usdValue`. **No change needed** — it already keys off usdValue, which will now reflect priceAtTime.
- `src/modules/transactions/transactions.schemas.ts`: `commonFields` (7-14), `NativeTransactionSchema`/`Erc20TransactionSchema`/`NftTransactionSchema` (16-46) all `.strict()`, `decimalStr` (5), `UpdateTransactionBodySchema` (59-75).
- `src/modules/transactions/transactions.service.ts`: `createTransaction` computes usd at :149 `computeUsdValue(body.symbol, body.amount)`, writes detail at :177-191, base row at :156-165; `updateTransaction` recompute at :439/:462-467/:487-492; `createTransactionFromWebhook` at :231-331 (leave on current price).
- `src/modules/transactions/transactions.repository.ts`: `createTransactionRow` (88-93), `createNativeDetail` (95-101), `createErc20Detail` (103-116), `updateTransactionBase` (131-143), `updateNativeDetail` (145-151), `updateErc20Detail` (153-166).
- `src/modules/transactions/transactions.dto.ts`: `TransactionListDTO` (20-42), `NativeDetailDTO`/`Erc20DetailDTO` (44-55), `toTransactionListDTO` (68-100), `toTransactionDetailDTO` (102-133).

## 1. Changes

### 1.1 Schema deltas [LOCKED] — NOTE comments in the retrofit-2 style; Idowu owns the docx
```prisma
// Transaction
notes  String?  @db.VarChar(2000)   // retrofit-7: user note (frontend AddTransactionModal)
// NativeTransactionDetail AND Erc20TransactionDetail
priceAtTime  Decimal?  @db.Decimal(20, 8)  // retrofit-7: user-entered price at tx time; drives usdValue for manual entries. Null for webhook/connected (current price). Reverses the retrofit-2 "current price" simplification for manual txns.
```
One migration. `usdValue` stays NOT NULL; `priceAtTime` is the new nullable column.

### 1.2 `computeUsdValue` — optional priceAtTime override [LOCKED]
`computeUsdValue(symbol: string, amount: string, priceAtTime?: string): Promise<string>`:
- If `priceAtTime` is a valid non-negative decimal, `usd = Number(amount) * Number(priceAtTime)` → `toFixed(8)` (skip Redis/DB).
- Else: existing current-price path unchanged.
- Update the header NOTE: manual buy/sell use the entered priceAtTime (accurate cost basis); webhook/connected omit it and use current price.

### 1.3 Schemas [LOCKED]
- `commonFields` += `notes: z.string().max(2000).nullable().optional()`.
- `NativeTransactionSchema` + `Erc20TransactionSchema` += `priceAtTime: decimalStr.optional()`. **Not** on NFT.
- `UpdateTransactionBodySchema` += `priceAtTime: decimalStr.optional()` and `notes: z.string().max(2000).nullable().optional()`.

### 1.4 `createTransaction` [LOCKED]
- `usdValue = await computeUsdValue(body.symbol, body.amount, body.priceAtTime)` (priceAtTime exists only on native/erc20 bodies).
- `createTransactionRow(... , notes: body.notes ?? null)`.
- `createNativeDetail`/`createErc20Detail(... , priceAtTime: body.priceAtTime ?? null)`.

### 1.5 `updateTransaction` [LOCKED]
- `usdAffected = body.amount !== undefined || body.symbol !== undefined || body.priceAtTime !== undefined`.
- On recompute use the new priceAtTime if given, else the stored detail priceAtTime, else current price:
  `computeUsdValue(newSymbol, newAmount, body.priceAtTime ?? existing.<native|erc20>Detail?.priceAtTime?.toString())`.
- Persist `priceAtTime` on the detail update when provided; persist `notes` on the base update when provided (add to `updateTransactionBase`).

### 1.6 DTO [LOCKED]
- `TransactionListDTO` += `notes: string | null`; `toTransactionListDTO` → `notes: tx.notes ?? null`.
- `NativeDetailDTO` + `Erc20DetailDTO` += `priceAtTime: number | null`; `toTransactionDetailDTO` sets it from the detail (`Number(detail.priceAtTime.toString())` or null).

### 1.7 Webhook path — explicitly unchanged
`createTransactionFromWebhook` keeps current-price usd (no priceAtTime arg); its detail rows get `priceAtTime = null`. Don't touch its price source.

## 2. Scope
```
prisma/schema.prisma + prisma/migrations/<new>   # Transaction.notes + 2× detail.priceAtTime
src/modules/transactions/usd-value.ts            # priceAtTime override + NOTE update
src/modules/transactions/transactions.schemas.ts # notes + priceAtTime
src/modules/transactions/transactions.service.ts # create/update wiring
src/modules/transactions/transactions.repository.ts # row/detail create+update params
src/modules/transactions/transactions.dto.ts     # surface notes + priceAtTime
tests/transactions.test.ts                       # new + adjusted tests
```
No asset-add seeding (C3b). No frontend. No env.

## 3. Tests
- POST native buy `{amount:'1', symbol:'BTC', priceAtTime:'30000', direction:'buy', ...}` → detail `usdValue = 30000` (NOT current price); `netDeposit`/PnL reflect 30000.
- POST without `priceAtTime` → `usdValue` = current price (back-compat path intact).
- `notes` persists and appears on both list + detail DTOs; `priceAtTime` appears on the detail DTO.
- PATCH `priceAtTime` → `usdValue` recomputed; PATCH `notes` → updated.
- **Check `tests/analytics.test.ts` (326) + existing `tests/transactions.test.ts`:** if they seed transactions/detail `usdValue` directly via Prisma, they're unaffected; if they POST via the API without `priceAtTime`, the current-price path keeps them green. Adjust only what actually breaks — don't loosen assertions.

## 4. STOP-and-ask gates
1. If any existing test POSTs a transaction and asserts a specific `usdValue` that the optional-priceAtTime change alters unexpectedly, surface it (it shouldn't — priceAtTime is optional).
2. The update-recompute edge (amount changes, no new priceAtTime → use stored priceAtTime, else current price): if a test pins different behavior, surface rather than guess.
3. `priceAtTime` nullable alongside retrofit-2's NOT-NULL `usdValue` — keep usdValue NOT NULL; if the migration ordering fights TimescaleDB or the detail tables, surface.

## 5. What NOT to do
- Don't change `createTransactionFromWebhook`'s price source — webhook stays current-price, `priceAtTime` null.
- Don't make `priceAtTime` required — it's an optional override.
- No NFT `priceAtTime`. No asset-add changes (C3b). No docx edits. No `git add -A`; leave stale `stage-14*.md` + `frontend-audit.md` untracked.

## 6. Commit and report
```bash
git add prisma/schema.prisma prisma/migrations \
        src/modules/transactions/usd-value.ts \
        src/modules/transactions/transactions.schemas.ts \
        src/modules/transactions/transactions.service.ts \
        src/modules/transactions/transactions.repository.ts \
        src/modules/transactions/transactions.dto.ts \
        tests/transactions.test.ts \
        _claude/retrofit-7.md
git commit -m "feat(transactions): priceAtTime drives usdValue for manual entries + transaction notes (retrofit-7)"
git log --oneline -3
```
Report: new SHA; a manual buy with priceAtTime showing `usdValue = amount × priceAtTime` and the resulting accurate netDeposit/PnL; webhook path still current-price; notes round-trip; full suite count; doc-fix items (Transaction.notes; detail.priceAtTime ×2; **usdValue basis change for manual txns — reverses retrofit-2 Option a**). If blocked, output the question and STOP.
