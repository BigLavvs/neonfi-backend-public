# retrofit-50 — Overview portfolio filter + connected-wallet resync

Depends on retrofit-49 (connected-wallet history import / `syncConnectedHoldings`). Do 49 first.

Two backend additions the frontend needs:

## 1. `?portfolioIds=` filter on GET /overview

So the Performance page's portfolio selector can scope the aggregate to one or more portfolios
(default = all, unchanged).

`overview.controller.ts` — extend `OverviewQuerySchema` and the handler:
```ts
// comma-separated positive ints; empty/absent = all of the user's portfolios.
portfolioIds: z.string().optional(),
// in the handler:
const ids = (c.req.query('portfolioIds') ?? '')
  .split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
const data = await getOverview(user.id, { days, txLimit, portfolioIds: ids.length ? ids : undefined });
```

`overview.service.ts` `getOverview(userId, opts)` — when `opts.portfolioIds` is set, restrict EVERY
per-portfolio query to `portfolio.userId === userId AND portfolio.id IN opts.portfolioIds` (validate
they belong to the user — silently drop ids that don't). Totals, valueHistory, allocation, holdings,
recentTransactions, transactionCount, portfolios[] all reflect only the selected set. When undefined,
behaviour is exactly as today. (Add the filter to the repository reads the service already does;
don't special-case — just thread an optional id whitelist into the `where`.)

## 2. POST /portfolios/:id/resync (connected only)

Catches transfers a missed/late webhook didn't deliver, and re-reconciles the balance to on-chain.

`portfolios.controller.ts` — authed, ownership-gated (mirror the existing `/:id` routes):
```ts
router.post('/:id/resync', async (c) => {
  const portfolio = c.get('portfolio'); // set by the ownership middleware
  if (portfolio.type.name !== 'connected') {
    return c.json(err('NOT_CONNECTED', 'Resync is only for connected wallet portfolios'), 400);
  }
  const result = await resyncConnectedHoldings(portfolio.id, portfolio.walletAddress, portfolio.chain);
  return c.json(ok(result), 200); // { importedTransfers, reconciled }
});
```

`wallet-data/sync.ts` — add `resyncConnectedHoldings(portfolioId, address, chain)`. Reuse the
retrofit-49 import path but make it **idempotent**:
- Re-import the latest transfer page (dedupe on tx `hash` — the existing unique constraint means
  already-recorded transfers are no-ops; only genuinely missed ones get inserted). Resolve/auto-list +
  trim amounts exactly as the initial sync.
- Re-import current NFT holdings (upsert present, delete vanished — same as the webhook).
- Re-reconcile balances: for each held token, `residual = providerCurrentBalance − netRecordedTxs`.
  UPDATE the existing wallet-sync opening lot to that residual instead of inserting a new one (so
  resync never duplicates). To make that possible, retrofit-49's `syncConnectedHoldings` should TAG its
  reconciling opening lot (e.g. `notes: 'wallet-sync:opening'`); resync finds that row per token and
  updates its amount (creating it only if absent). Then `recalc` + `invalidatePnlCache`.
- Best-effort: per-token failures log & continue; return counts.

Idempotency is the whole point — running resync twice in a row must not change balances or create
duplicate rows.

## Validate
- `npm run typecheck` + singleton check clean.
- `/overview?portfolioIds=<id>` returns totals/holdings/history for just that portfolio; absent = all;
  ids not owned by the user are ignored.
- resync on a connected portfolio with a deliberately-deleted transfer re-imports exactly that one
  (dedupe leaves the rest untouched); running it again is a no-op; balance == on-chain after.
- resync on a manual portfolio → 400 NOT_CONNECTED.
- Regression: overview / portfolios / transactions suites green.

## Out of scope
- Moralis stream/webhook, manual path, retrofit-49's initial-sync contract (only ADD the opening-lot tag).
