# Neonfi backend — Retrofit 2: usdValue + netDeposit + PnL cache invalidation

This file is the source-of-truth intent for retrofit-2. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: bbf91ec (retrofit-1).

Background: Idowu locked **Option (a)** for the USD-at-transaction-time decision. This retrofit implements the schema delta + all downstream wiring so:
- Manual portfolio PnL stops being fictional (A1)
- Connected portfolio PnL stops being fictional (also A1, via the webhook bypass)
- `Portfolio.netDeposit` gets populated (A2)
- Redis PnL cache invalidation gets wired in (A3) — even though the cache itself ships in retrofit-3, the invalidation hooks must exist so retrofit-3 doesn't need to retrofit every CUD path again
- The Transaction list endpoint returns `amount`/`symbol`/`usdValue` per row instead of forcing a per-row detail fetch (A8)

Out of scope: the snapshots/ module structure, the `GET /portfolios/:id/snapshots` endpoint, missed-snapshot flagging, derive.ts cache GET/SET — all of those land in retrofit-3. Stage 14 analytics and Stage 15 email retries come after retrofit-3.

## 0. Read first

This retrofit touches more files than retrofit-1. Read each one before editing. The audit found that prompts written from memory rather than from actual code created silent debt. Don't repeat that.

1. `prisma/schema.prisma` — the `NativeTransactionDetail` (lines 339-347), `Erc20TransactionDetail` (lines 349-360), `Portfolio` (lines 232-263), and `Asset` (lines 273-288) models. Verify the column types before writing the migration.
2. `prisma/migrations/20260612100000_transaction_direction/migration.sql` — the established hand-written migration pattern (small SQL file applied via `prisma db execute`). Mirror its style.
3. `_claude/stage-1a.md` and `_claude/retrofit-1.md` — for the Neon-shadow-DB migration pattern (`prisma db execute --file ... --url $env:DIRECT_URL` → `prisma migrate resolve --applied <name>` → `prisma generate`).
4. `src/modules/transactions/recalc.ts` (full — only 50 lines) — the current balance-only recalc. You'll extend it to also recalc `Asset.netDeposit`.
5. `src/modules/transactions/transactions.service.ts` (full — 466 lines) — the 4 mutation paths: `createTransaction` (53-148), `createTransactionFromWebhook` (163-251), `updateTransaction` (290-430), `deleteTransaction` (436-465). Each needs the usdValue population AND the PnL cache invalidation hook.
6. `src/modules/transactions/transactions.repository.ts` (full) — the `createNativeDetail`, `createErc20Detail`, `updateNativeDetail`, `updateErc20Detail` helper signatures. They need to accept `usdValue`. Also the `listTransactions` query — needs to include nativeDetail + erc20Detail joins.
7. `src/modules/transactions/transactions.dto.ts` (full — 100 lines after retrofit-1) — the `TransactionListDTO` interface. Add `amount`, `symbol`, `usdValue` (all nullable for the nft case).
8. `src/modules/portfolios/portfolios.service.ts` (full — 190 lines) — the `createPortfolio` function. The current path (line 73-130) does NOT set `Portfolio.netDeposit`.
9. `src/modules/portfolios/portfolios.repository.ts` (full — only 63 lines) — `createPortfolioRow` (lines 43-52) needs to accept `netDeposit`.
10. `src/modules/portfolios/derive.ts` (full — 47 lines) — the cache key pattern is documented in its top comment (`portfolio_pnl:<portfolioId>`, 5-min TTL). Verify the key name you use for invalidation matches what derive.ts will read from in retrofit-3.
11. `src/modules/webhooks/moralis-handlers.ts` (read `processNativeTx` and `processErc20Transfer` blocks — lines 185-319) — these call `createTransactionFromWebhook`, so they don't need direct edits, but verify the createTransactionFromWebhook body shape they construct includes nothing that conflicts with the new usdValue handling.
12. `src/lib/redis.ts` — confirm `redis.del` is the right method on the ioredis client (it is, but verify by reading the file).

## 1. Architecture decisions

### 1.1 Schema delta — `usdValue: Decimal(20,8) NOT NULL` on both detail tables [LOCKED]

Same precision as `amount` and `Token.currentPrice`. Both tables (NativeTransactionDetail, Erc20TransactionDetail) get the column. NftTransactionDetail does NOT — NFTs are ownership state, not balance-affecting, no PnL contribution.

```sql
-- NativeTransactionDetail
ALTER TABLE "native_transaction_detail" ADD COLUMN "usdValue" DECIMAL(20, 8);
-- Backfill from current Token.currentPrice × amount
UPDATE "native_transaction_detail" nd
SET "usdValue" = nd."amount" * t."currentPrice"
FROM "token" t
WHERE t."symbol" = nd."symbol";
-- Any rows where the token isn't in the catalog (shouldn't exist in practice
-- but guard against null-fail on NOT NULL): backfill to 0.
UPDATE "native_transaction_detail" SET "usdValue" = 0 WHERE "usdValue" IS NULL;
-- Lock NOT NULL
ALTER TABLE "native_transaction_detail" ALTER COLUMN "usdValue" SET NOT NULL;

-- Erc20TransactionDetail — same shape
ALTER TABLE "erc20_transaction_detail" ADD COLUMN "usdValue" DECIMAL(20, 8);
UPDATE "erc20_transaction_detail" ed
SET "usdValue" = ed."amount" * t."currentPrice"
FROM "token" t
WHERE t."symbol" = ed."symbol";
UPDATE "erc20_transaction_detail" SET "usdValue" = 0 WHERE "usdValue" IS NULL;
ALTER TABLE "erc20_transaction_detail" ALTER COLUMN "usdValue" SET NOT NULL;
```

Apply via the established Neon-shadow-DB pattern (mirrors Stage 9A's transaction_direction migration):

```powershell
npx prisma db execute --file prisma/migrations/<ts>_transaction_detail_usd_value/migration.sql --url $env:DIRECT_URL
npx prisma migrate resolve --applied <ts>_transaction_detail_usd_value
npx prisma generate
```

Update Prisma schema to mark both `usdValue` fields with a NOTE comment explaining the "current price at write-time" MVP simplification (see §1.3) and pointing at this retrofit. Add to the doc-fix pile: "Neonfi Database Schema.docx: add `usdValue Decimal(20,8)` to NativeTransactionDetail and Erc20TransactionDetail. Same schema-vs-architecture defect family as Transaction.direction (Stage 9A) and Nft marketplace fields (Stage 12)."

### 1.2 Backfill semantics [LOCKED — acceptable MVP simplification]

The migration backfills existing rows using current `Token.currentPrice`, NOT the price at the historical transaction timestamp. This is wrong for accurate historical PnL but acceptable for two reasons:
1. No historical price data exists — we never stored it.
2. The dev DB currently has a tiny number of test transactions; production hasn't shipped.

Lock this behavior in a code comment on the migration AND in the NOTE on the Prisma fields. If, post-MVP, we acquire historical price data (e.g. via CMC historical API), a follow-up retrofit can backfill more accurately.

### 1.3 New transactions populate `usdValue` from price-now [LOCKED]

For every new transaction created (manual via `createTransaction`, webhook via `createTransactionFromWebhook`), look up the current price for the symbol and compute `usdValue = amount × price`. Storage format: string representation of the Decimal.

Price lookup priority:
1. **Redis cache** at `price:<SYMBOL>` (60s TTL — Coinbase WS writes here per `src/lib/coinbase.ts:110`). Parse JSON `{price, change24h, timestamp}` and use `.price`.
2. **DB fallback**: `Token.currentPrice` for that symbol.
3. **No price available**: use `0` and log a warning. Better than failing — connected portfolios in particular can have webhooks arrive faster than tokens get seeded.

Implementation lives in a new helper in `src/modules/transactions/usd-value.ts` (NEW file):

```ts
// src/modules/transactions/usd-value.ts (NEW)
//
// Computes the USD value of a transaction at write-time. Used by createTransaction
// (manual) and createTransactionFromWebhook (Stage 11 / Moralis). Price priority:
// Redis live cache (60s, Coinbase WS) → Token.currentPrice (DB) → 0 + warn.
//
// MVP simplification: this is the CURRENT price at write-time. Historical
// transactions get the current price too. PnL is therefore approximate. A
// follow-up retrofit could backfill from CMC historical data if accuracy
// matters; out of scope here.

import { redis } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';

export async function computeUsdValue(symbol: string, amount: string): Promise<string> {
  const cached = await redis.get(`price:${symbol}`);
  let price: number | null = null;

  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { price?: number };
      if (typeof parsed.price === 'number' && Number.isFinite(parsed.price)) {
        price = parsed.price;
      }
    } catch {
      // ignore — fall through to DB
    }
  }

  if (price === null) {
    const token = await prisma.token.findUnique({ where: { symbol }, select: { currentPrice: true } });
    if (token) price = Number(token.currentPrice.toString());
  }

  if (price === null) {
    console.warn(`[usd-value] no price for ${symbol}; defaulting usdValue=0`);
    return '0';
  }

  const amt = Number(amount);
  const usd = amt * price;
  // Keep Decimal(20,8) precision when serializing
  return usd.toFixed(8);
}
```

Cross-module note: this helper does query the Token table directly (cross-module). This is acceptable here because it's a one-line read with no domain logic — the alternative (calling tokens.service for a single price lookup on every transaction) adds indirection without benefit. Document this as a deliberate exception in a comment, same way `auth/plan.ts` documents its direct subscription read.

### 1.4 `Asset.netDeposit` and `Portfolio.netDeposit` derived from `usdValue` [LOCKED]

Extend `recalc.ts` to maintain both alongside `balance`.

**Per-asset rule**:
- `Asset.balance` = sum(buy amount) − sum(sell amount) (existing behavior, unchanged)
- `Asset.netDeposit` = sum(buy usdValue) − sum(sell usdValue) (NEW)

Both computed in the same loop over the asset's transactions. Single `prisma.asset.updateMany` writes both fields.

**Per-portfolio rule**:
- `Portfolio.netDeposit` = sum across all the portfolio's assets of their `netDeposit`

After per-asset recalc, also recompute the portfolio's `netDeposit`. New helper in recalc.ts:

```ts
export async function recalcPortfolioNetDeposit(
  tx: TxClient,
  portfolioId: number,
): Promise<void> {
  const assets = await tx.asset.findMany({
    where: { portfolioId },
    select: { netDeposit: true },
  });
  const total = assets.reduce(
    (sum, a) => sum + Number(a.netDeposit.toString()),
    0,
  );
  await tx.portfolio.update({
    where: { id: portfolioId },
    data: { netDeposit: total.toFixed(8) },
  });
}
```

Caller pattern (transactions.service): inside the `$transaction`, after `recalcAssetBalance`, call `recalcPortfolioNetDeposit`. Same transaction, same timeout.

### 1.5 `createPortfolio` populates `Portfolio.netDeposit` from `startingBalance` [LOCKED]

For manual portfolios: `Portfolio.netDeposit` initializes to `startingBalance ?? '0'`. For connected portfolios: starts at `0`, grows via webhook IN transactions (which `createTransactionFromWebhook` handles via the recalc chain).

`portfolios.repository.createPortfolioRow` (line 43-52) needs a new optional param `netDeposit?: string`. `portfolios.service.createPortfolio` (line 52-131) passes it on the manual path:

```ts
// In createPortfolio, manual branch (lines 123-131):
const portfolio = await createPortfolioRow({
  userId,
  name: body.name,
  typeId: portfolioType.id,
  startingBalance: body.startingBalance,
  netDeposit: body.startingBalance ?? '0',  // NEW
});
```

The connected branch (lines 95-101) does NOT pass netDeposit (defaults to 0 via the schema).

### 1.6 PnL cache invalidation hooked into every mutation [LOCKED]

Build Guide §4.3 step 4 and §6.3 mandate: "After commit: Redis PnL cache invalidated for the portfolio." The cache key is `portfolio_pnl:<portfolioId>` per derive.ts top comment.

Add invalidation AFTER each successful $transaction commit in:
- `transactions.service.createTransaction` — line 145 (after the `$transaction` returns, before the `findTransactionById` lookup)
- `transactions.service.createTransactionFromWebhook` — line 246 (same position)
- `transactions.service.updateTransaction` — line 425 (after `$transaction` returns)
- `transactions.service.deleteTransaction` — line 463 (after `$transaction` returns)

```ts
// Pattern (place AFTER the $transaction commits — invalidation must not roll back if it fails):
await redis.del(`portfolio_pnl:${portfolio.id}`).catch((e: Error) =>
  console.error(`[transactions] cache invalidation failed for portfolio ${portfolio.id}:`, e.message),
);
```

The `.catch` keeps cache-invalidation failures from rolling back the transaction. Stale PnL for 5 minutes is recoverable; a failed write is not.

Note: the cache itself doesn't exist yet — `derive.ts` doesn't read from Redis. So this invalidation hits a key that may not exist. `redis.del` is a no-op in that case. Wiring it now means retrofit-3 (which adds the GET/SET in derive.ts) doesn't have to retrofit every CUD callsite again.

Import `redis` from `../../lib/redis.js` at the top of `transactions.service.ts` (already imported in moralis-handlers.ts, pattern is established).

### 1.7 `TransactionListDTO` gains `amount`, `symbol`, `usdValue` [LOCKED]

Architecture line 934 specifies the list response shape includes `type, from, to, amount, symbol, timestamp`. Current implementation (transactions.dto.ts after retrofit-1) returns `type, direction, status, from, to, gasFee, transactionHash, timestamp, createdAt` — missing `amount`, `symbol`, AND now we add `usdValue`.

Updated DTO:

```ts
export interface TransactionListDTO {
  id: number;
  portfolioId: number;
  type: string;
  direction: string;
  status: 'completed';
  from: string | null;
  to: string | null;
  gasFee: number | null;
  transactionHash: string | null;
  // NEW: amount/symbol/usdValue come from the child detail (native or erc20).
  // null for nft type — no balance, no USD value.
  amount: number | null;
  symbol: string | null;
  usdValue: number | null;
  timestamp: string;
  createdAt: string;
}
```

The list query in `transactions.repository.listTransactions` must include nativeDetail + erc20Detail. The current include is just `{ type: true, direction: true }`. Extend to:

```ts
include: {
  type: true,
  direction: true,
  nativeDetail: true,
  erc20Detail: true,
},
```

Note: do NOT include nftDetail in the LIST query — there's no amount/symbol/usdValue to surface for NFT transactions and the join cost is wasted.

The `toTransactionListDTO` mapper now picks amount/symbol/usdValue from whichever detail is present:

```ts
export function toTransactionListDTO(tx: TransactionWithListIncludes): TransactionListDTO {
  let amount: number | null = null;
  let symbol: string | null = null;
  let usdValue: number | null = null;

  if (tx.nativeDetail) {
    amount = Number(tx.nativeDetail.amount.toString());
    symbol = tx.nativeDetail.symbol;
    usdValue = Number(tx.nativeDetail.usdValue.toString());
  } else if (tx.erc20Detail) {
    amount = Number(tx.erc20Detail.amount.toString());
    symbol = tx.erc20Detail.symbol;
    usdValue = Number(tx.erc20Detail.usdValue.toString());
  }
  // For nft transactions: all three remain null.

  return {
    id: tx.id,
    portfolioId: tx.portfolioId,
    type: tx.type.name,
    direction: tx.direction.name,
    status: 'completed',
    from: tx.from ?? null,
    to: tx.to ?? null,
    gasFee: tx.gasFee !== null ? Number(tx.gasFee.toString()) : null,
    transactionHash: tx.transactionHash ?? null,
    amount,
    symbol,
    usdValue,
    timestamp: tx.timestamp.toISOString(),
    createdAt: tx.createdAt.toISOString(),
  };
}
```

You'll need a new `TransactionWithListIncludes` type alongside the existing `TransactionWithTypeDirection` — the list query now includes more fields. Replace the type alias OR add a new one and update the callsite in `transactions.service.listPortfolioTransactions`.

`TransactionDetailDTO extends TransactionListDTO` (line 50 in retrofit-1's state) so detail inherits amount/symbol/usdValue automatically. But the detail's `detail` sub-object STILL carries amount/symbol redundantly — that's OK, leave it alone. The architecture rep treats the per-type `detail` as type-specific structured data; the top-level amount/symbol/usdValue are the listing-friendly flat fields.

### 1.8 `updateTransaction` recomputes `usdValue` if `amount` or `symbol` changes [LOCKED]

Mirror the existing pattern (transactions.service.ts:351-352) where `balanceAffected = direction !== undefined || amount !== undefined || symbol !== undefined`. Add:

```ts
const usdAffected = body.amount !== undefined || body.symbol !== undefined;

// Inside the $transaction:
if (usdAffected && (typeName === 'native' || typeName === 'erc20')) {
  const newSymbol = body.symbol ?? oldSymbol ?? '';
  const newAmount = body.amount ?? /* existing amount */;
  if (newSymbol) {
    const newUsdValue = await computeUsdValue(newSymbol, newAmount);
    if (typeName === 'native') {
      await updateNativeDetail(tx, txId, { usdValue: newUsdValue });
    } else {
      await updateErc20Detail(tx, txId, { usdValue: newUsdValue });
    }
  }
}
```

Be precise about reading the existing amount/symbol from `existing.nativeDetail` or `existing.erc20Detail` when the PATCH body omits them. Don't compute `usdValue = price × undefined`.

`updateNativeDetail` and `updateErc20Detail` signatures gain `usdValue?: string`.

### 1.9 `deleteTransaction` doesn't compute usdValue but DOES recalc both Asset and Portfolio netDeposit [LOCKED]

After deletion, the recalc helpers re-sum the remaining transactions. So delete doesn't need to compute anything — just call recalc, which now also touches netDeposit. Same code path as today, only `recalcAssetBalance` now updates two fields and we follow with `recalcPortfolioNetDeposit`.

## 2. Module scope

```
prisma/schema.prisma                                          # EDIT — add usdValue fields with NOTE
prisma/migrations/<ts>_transaction_detail_usd_value/...       # NEW — hand-written
src/modules/transactions/usd-value.ts                         # NEW — computeUsdValue helper (§1.3)
src/modules/transactions/recalc.ts                            # EDIT — maintain Asset.netDeposit + add recalcPortfolioNetDeposit
src/modules/transactions/transactions.service.ts              # EDIT — 4 mutation paths: populate usdValue, invalidate cache
src/modules/transactions/transactions.repository.ts           # EDIT — listTransactions include + detail helpers accept usdValue
src/modules/transactions/transactions.dto.ts                  # EDIT — TransactionListDTO gains amount/symbol/usdValue
src/modules/portfolios/portfolios.service.ts                  # EDIT — manual path passes netDeposit
src/modules/portfolios/portfolios.repository.ts               # EDIT — createPortfolioRow accepts netDeposit
tests/transactions.test.ts                                    # EDIT — new asserts on usdValue + amount/symbol in list + netDeposit
tests/portfolios.test.ts                                      # EDIT — assert Portfolio.netDeposit = startingBalance on manual create
```

No new module. No edits to moralis-handlers.ts (it calls createTransactionFromWebhook which handles usdValue internally). No new endpoints.

## 3. Tests (Vitest, integration — extend existing files)

New tests numbered 303+.

In `tests/transactions.test.ts`:

303. **POST native buy → NativeTransactionDetail.usdValue persisted as `amount × Token.currentPrice`.** Use BTC at the seeded price (93000) and amount=0.5, expect usdValue ≈ 46500.
304. **POST erc20 buy → Erc20TransactionDetail.usdValue persisted similarly.** Use a seeded ERC20 (e.g. USDT or LINK).
305. **POST native buy followed by POST native sell → `Asset.netDeposit` = buy.usdValue − sell.usdValue.** Verify by reading the asset row after both POSTs.
306. **`Portfolio.netDeposit` reflects sum of asset netDeposits after the buys/sells in 305.** Read portfolio after the second transaction.
307. **GET /portfolios/:id/transactions list response includes `amount`, `symbol`, `usdValue` per row.** Assert presence on at least one native and one erc20 entry.
308. **PATCH amount on a native transaction → usdValue recomputed.** PATCH amount 0.5 → 1.0 on a BTC tx, expect usdValue doubles.
309. **DELETE transaction → asset balance, asset netDeposit, portfolio netDeposit all recompute correctly.** Sequence: buy 1 BTC → buy 1 ETH → delete the BTC buy → asset balances + netDeposits + portfolio.netDeposit all reflect only the ETH state.
310. **PnL cache invalidation hits the right key.** Mock `redis.del` (or assert via spy), POST a transaction, assert `redis.del('portfolio_pnl:<id>')` was called exactly once with the right key.

In `tests/portfolios.test.ts`:

311. **POST manual portfolio with startingBalance=5000 → Portfolio.netDeposit = 5000.** Read portfolio after creation, expect netDeposit = '5000'.
312. **POST connected portfolio → Portfolio.netDeposit = 0.** Connected portfolios start empty.

Plus update any existing tests that previously asserted Portfolio.netDeposit was 0 or null (per pre-retrofit-2 behavior). Search `tests/portfolios.test.ts` for `netDeposit` and update assertions to match new semantics.

Plus update any existing transaction list-response assertions to expect amount/symbol/usdValue/null appropriately.

## 4. STOP-AND-ASK gates

1. **If the migration backfill UPDATE produces NULL `usdValue` for any row** (e.g. an existing detail references a symbol not in the token table), the safety-net `UPDATE ... SET usdValue = 0 WHERE usdValue IS NULL` catches it. If the SET NOT NULL still fails, STOP — there's a row the safety net missed. Inspect with `SELECT * FROM native_transaction_detail WHERE usdValue IS NULL`.
2. **If existing transactions tests assert exact Asset.netDeposit values** that no longer match (because retrofit-2 now maintains them rather than leaving them at 0), update the assertions to the new correct values. Don't paper over by skipping the test.
3. **If `computeUsdValue` returns `'0'` for a symbol that IS in the catalog**, that means both Redis cache miss AND DB lookup miss. Surface as a warning log (already in the helper) but also STOP for one specific case: if the test DB seed includes the token with a non-zero `currentPrice` and the helper still returns 0, there's a bug.
4. **If TypeScript complains about `TransactionWithListIncludes` shape after extending the include**, the right fix is updating the type — not loosening the includes. Surface the error so we keep the include matching what the mapper expects.
5. **If `redis.del` is called with a key that doesn't exist** (it returns 0 — no error) and a test asserts on the return value, that's expected. The `.catch` swallows real network errors only.
6. **If any other test file breaks because of changed PortfolioDTO shape or list response shape**, that's the same kind of legitimate fallout retrofit-1 surfaced for A7. Update assertions; do not back out.

## 5. What NOT to do

- **No edits to derive.ts.** retrofit-3 owns the cache GET/SET wiring there. retrofit-2 only invalidates.
- **No new `snapshots/` module.** retrofit-3.
- **No `GET /portfolios/:id/snapshots` endpoint.** retrofit-3.
- **No edits to NftTransactionDetail.** NFTs don't have balance or PnL.
- **No editing the architecture or schema docx.** Doc-fix items go in the commit report.
- **No backfilling Asset.netDeposit / Portfolio.netDeposit from historical transactions** in the migration. Those fields get maintained going forward; the migration only handles per-detail usdValue. Existing assets and portfolios stay at whatever netDeposit they have (almost certainly 0). The first transaction CUD on each asset will trigger the recalc and set it correctly.
- **No `npm audit fix`.**
- **No bundling stage-14.md in this commit.** Same scope-leak risk retrofit-1 caught — explicitly stage the retrofit-2 files only.

## 6. Commit and report

Stage explicitly (mirror retrofit-1's discipline — don't `git add -A`):

```bash
git add prisma/schema.prisma prisma/migrations/<ts>_transaction_detail_usd_value/migration.sql \
        src/modules/transactions/usd-value.ts \
        src/modules/transactions/recalc.ts \
        src/modules/transactions/transactions.service.ts \
        src/modules/transactions/transactions.repository.ts \
        src/modules/transactions/transactions.dto.ts \
        src/modules/portfolios/portfolios.service.ts \
        src/modules/portfolios/portfolios.repository.ts \
        tests/transactions.test.ts \
        tests/portfolios.test.ts \
        _claude/retrofit-2.md
git commit -m "fix(retrofit-2): usdValue schema delta + Asset/Portfolio netDeposit tracking + PnL cache invalidation"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation `prisma migrate status` shows the new migration as applied.
- One example transaction's persisted state: pick any seeded test scenario, show `nativeDetail.usdValue` non-zero.
- Confirmation `Asset.netDeposit` is non-zero on a portfolio with at least one buy transaction.
- Confirmation `Portfolio.netDeposit` matches sum of its assets' netDeposits.
- One example showing the GET /transactions list response includes `amount`, `symbol`, `usdValue` per native/erc20 row, and null for nft.
- Vitest output: all tests passing (count expected ~310: 302 baseline + ~10 new in retrofit-2).
- Doc-fix pile items added in retrofit-2:
  - `Neonfi Database Schema.docx`: add `usdValue Decimal(20,8) NOT NULL` to NativeTransactionDetail and Erc20TransactionDetail.
  - `Neonfi System Architecture.docx` (optional): note that transaction.detail responses now carry usdValue, and TransactionList responses surface amount/symbol/usdValue flat at the top level.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
