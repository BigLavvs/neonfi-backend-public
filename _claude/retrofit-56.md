# retrofit-56 — Connected-wallet value/count decoupling (Option B). CONNECTED ONLY.

> (Was retrofit-55; renumbered so retrofit-55 can be the small NFT `logoUrl` overflow fix.)

## The decision (already agreed)
Connected portfolios don't import every transaction (windowed feed + "load more"), so the frontend's
`reconstructValueSeries` (holdings rolled back by transactions) is **wrong** for them, and the tx count
was the ever-growing DB row count. Fix: connected portfolios use **recorded** value history
(`BalanceSnapshot`, backfilled) + a **fixed real** tx count. **Manual portfolios MUST NOT change** —
they keep frontend reconstruction exactly as-is. The aggregate chart = manual portion (reconstructed,
unchanged) **+** connected portion (recorded), summed.

## What already exists — DO NOT rebuild
- **Count consumption is already decoupled.** `overview.service.ts` (~L241–247) already does:
  `connected && externalTxCount != null ? externalTxCount : dbRowCount`. So the count bug is purely
  that `externalTxCount` isn't reliably set (Moralis history rarely returns a total). The fix is to
  **populate** it from a reliable source. No overview count logic change.
- **Recorded value history already aggregates.** `overview.service.ts buildValueHistory` (~L429) sums
  each portfolio's `BalanceSnapshot` series (forward-filled). We just need to (a) backfill connected
  snapshots and (b) expose a connected-only slice.

## ⚠️ Probe before you parse (the retrofit-54 lesson)
Do **not** assume Covalent/GoldRush response shapes or paths. Before writing any parser, hit the real
endpoints once with the configured key and confirm the JSON (status, field names, how many days
`portfolio_v2` actually returns — it may cap the window). Covalent base:
`https://api.covalenthq.com/v1/{chain}/address/{address}/…`, auth `Authorization: Bearer <GOLDRUSH key>`.
Chain slug→name map already exists in `goldrush.ts` (`COV_CHAIN`). Paste the probe output in the PR.

## 1. GoldRush provider — two new methods (`src/modules/wallet-data/providers/goldrush.ts`)
Both return null on non-ok/parse failure (callers degrade gracefully), mirroring `getSummary`.

a) `getTransactionCount(address, chainSlug): Promise<number | null>`
   - `GET /v1/{cov}/address/{address}/transactions_summary/?quote-currency=USD`
   - Return `data.items[0].total_count` (PROBE to confirm the path).

b) `getValueHistory(address, chainSlug, days): Promise<Array<{ date: string; value: number }> | null>`
   - `GET /v1/{cov}/address/{address}/portfolio_v2/?quote-currency=USD&days={days}` (try `days=365`;
     note the real cap from the probe).
   - Response is per-token (`data.items[]`), each with a daily `holdings[]` array carrying a USD
     value per day (likely `holdings[].close.quote` with `holdings[].timestamp`). **Sum across tokens
     per day** → `[{ date: 'YYYY-MM-DD', value }]`, ascending. PROBE the exact field names first.

Add both as **optional** methods on `WalletDataProvider` (like `getNftHoldings`), and add
`fetchTransactionCount` / `fetchValueHistory` wrappers in `wallet-data/index.ts` that loop providers
(GoldRush implements them; others skip).

## 2. Populate count + backfill snapshots on sync AND resync (`sync.ts`, connected only)
In both `syncConnectedHoldings` and `resyncConnectedHoldings`, after the existing import passes:

a) **Real count:** `const total = await fetchTransactionCount(address, chain);` and when non-null,
   write it to `externalTxCount` (replaces the current `externalTxCount: page?.totalCount` which is
   usually null). This is the fixed real total the overview already consumes.

b) **Snapshot backfill:** `const vh = await fetchValueHistory(address, chain, 365);` then for each
   `{ date, value }` **UPSERT** `BalanceSnapshot` on the composite PK `(portfolioId, snapshotDate)`,
   **create-only** (skip dates that already have a snapshot — never overwrite the daily job's rows or
   today's live value). `userId = portfolio.userId`, `value = Decimal(value)`, `snapshotDate = date`.
   Idempotent: a second resync writes nothing new.

Best-effort: wrap each in try/catch; a provider failure must not break the rest of the sync.

## 3. Overview — expose a connected-only recorded series (`overview.service.ts` + `overview.dto.ts`)
- Add `connectedValueHistory` to the payload: call the existing `buildValueHistory` with **only the
  connected portfolios'** snapshot arrays (filter `snapshotsList` by the matching portfolio's
  `type.name === 'connected'`, same `days`).
- Keep `valueHistory` (all portfolios) unchanged for back-compat.
- Add `connectedValueHistory: Array<{ date: string; value: number }>` to `OverviewDTO`.
- The per-portfolio DTO already carries `type` and `holdings`; make sure both stay in the payload (the
  frontend needs per-portfolio `type` + `holdings` to reconstruct the manual portion).

## 4. Frontend — I (Cowork) will do this after the backend lands; here for context
`dashboard/+page.ts` and `performance`: reconstruct **only** the manual portfolios (their per-portfolio
holdings + manual transactions × prices), then add `ov.connectedValueHistory`, summed per date.
Connected stops going through `reconstructValueSeries`. The wallet single-portfolio view for a connected
wallet uses the recorded series. Manual-only selections render byte-identical to today.

## 5. Validate
- typecheck + singleton check clean; probe outputs pasted.
- Connected portfolio: `externalTxCount` = real on-chain total (overview count stops moving when you
  "load more"); `BalanceSnapshot` gains pre-connection rows; `connectedValueHistory` non-empty.
- **Manual regression:** a manual portfolio's `externalTxCount`, snapshots, count, and `valueHistory`
  are unchanged. Diff a manual portfolio's `/overview` before/after — must be identical.
- Suites green: overview, snapshots, wallet-preview, sync/wallet-data.

## Out of scope
- Manual portfolio behaviour (must be identical).
- Intraday (1H/1D) granularity for connected — recorded snapshots are daily; connected charts are
  daily resolution. Acceptable per Option B.
- Floor price; the webhook stream path.
