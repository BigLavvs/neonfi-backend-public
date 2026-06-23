# retrofit-74 — Real transaction count in overview + paginated transactions (REVERT the throttled H10 count)

## What this corrects
retrofit-73 (H10) was wrong: it changed the overview transaction count from the wallet's **real total** to
"rows imported so far" (17), which understates the user's actual activity. The real count (~420) was always
correct — the only real problem was that the transactions **table** showed just the first page. So: show
the real count, and paginate the table (50 at a time, load-more for Pro). Do NOT show a throttled count,
and do NOT show a dual "imported · on-chain" number.

## Backend
1. **Overview count = the real total (revert H10).** `overview.service.ts`: `transactionCount` =
   the connected wallet's real total (`externalTxCount`, already resolved by `resolveExternalTxCount`) +
   manual portfolios' DB rows — i.e. restore the pre-H10 behaviour. **Remove `onChainTransactionCount`**
   and its DTO field (one honest number, no split). Dedupe `externalTxCount` by wallet address so the same
   wallet connected in two portfolios isn't double-counted.
2. **Sync pulls the latest 50** (was 100): set `PAGE_LIMIT = 50` in `sync.ts` (initial sync + resync).
3. **Load-more pulls the NEXT 50, Pro only.** `transactionsSyncMore` (retrofit-49 §6) imports the next
   page via the stored `syncCursor` — keep page size 50 and gate it to **Pro** (free user → 403
   `PLAN_LIMIT_REACHED`/no-op). The cursor already advances so each press pulls the next 50.
4. **Per-portfolio transaction hash** so a connected wallet's transfers import per portfolio instead of
   being globally dedup-blocked: `transactionHash` → drop global `@unique`, add
   `@@unique([portfolioId, transactionHash])` (migration + the P2002/`isDuplicateHash` dedupe keyed on the
   composite). Without this, a re-added/shared wallet imports 0 transfers even though the count is right.

## Frontend (Cowork — done alongside)
- Dashboard "Transactions" stat → reverts to the real count automatically once the backend count does
  (it already reads `totals.transactionCount`). No dual-count UI.
- Wallet → Transactions tab: "Load more" button **hidden for free users**, shown for Pro (pulls next 50).
- **Group the Transactions tab by type:** filter chips/tabs — **All · Native · ERC-20 · NFT** — filtering
  the loaded transactions on `tx.type`, each chip showing its count (of the loaded set). Default "All",
  newest-first preserved within each group; load-more still appends to the underlying list.

## Validate
- `/overview.totals.transactionCount` = the wallet's real total (~420 for 0xcB1C…905), NOT 17.
- Initial sync imports 50 rows; Pro load-more imports the next 50; free user has no load-more (button gone +
  endpoint refuses).
- Same wallet in two portfolios → count not doubled; transfers import in each portfolio (per-portfolio hash).
- overview / wallet-preview / transactions suites updated (the old H10 test that asserted count=imported
  rows is reverted to assert the real total).
