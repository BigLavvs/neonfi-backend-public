# retrofit-88 — decisions + shipped surface

Two correctness/consistency gaps from the live 4-portfolio audit. Neither broke a displayed number,
both were real latent gaps.

## Issue 1 — per-portfolio `pnlAllTimeValue` aligned to the displayed all-time P&L

**Symptom.** The `/portfolios` summary DTO computed `pnlAllTimeValue = totalValue − netDeposit` (and
`pnlAllTime` % over netDeposit), but every DISPLAY surface (dashboard/overview totals + the Performance
headline) shows the cost-basis realized+unrealized measure. They diverge ONLY when a manual portfolio
holds a cost-unknown ("none" mode) asset: `netDeposit` excludes its unknown cost, so `value − netDeposit`
books that asset's whole value as phantom gain, while realized+unrealized honestly excludes it. Live P1:
`pnlAllTimeValue` $15,818 vs displayed `allTimePnlValue` $15,395 (Δ = DOGE's $416.30).

**Fix — scoped to `toPortfolioDTO` (`portfolios.dto.ts`), NOT `derive.ts`.** For MANUAL portfolios the
DTO now overrides `pnlAllTimeValue = derived.allTimePnlValue` and `pnlAllTime = derived.unrealizedPnlPct`
— exactly the overview's `canonicalAllTime('manual', d)` = `{ value: allTimePnlValue, pct:
unrealizedPnlPct }`. So `/portfolios.pnlAllTimeValue === allTimePnlValue === the overview's per-portfolio
P&L`. CONNECTED is unchanged: `derived.pnlAllTime*` already carries its cost-basis all-time
(`allTimePnlValue`) / `null`, matching `canonicalAllTime('connected')`.

**Why NOT change `derive.ts`.** `analytics.buildSummary` reads `derived.pnlAllTime` / `pnlAllTimeValue`
DIRECTLY and serves them as `allTimePnlPct` / `allTimePnlValue`. The analytics tests (326/327/328) assert
the netDeposit-based numbers (13000 / 16.25 / 93000) against cost-UNKNOWN seeded assets — changing
`derive.ts` would flip those to 0 and break the suite, which the spec forbids ("analytics stays green").
snapshots #323 (`netDeposit=10000 → pnlAllTimeValue=2500`) tests the same `derive.ts` netDeposit path
directly and would break too. Confirmed via the frontend: the Performance headline reads
`ov.totals.pnlAllTimeValue` (overview, realized+unrealized), NOT the analytics-summary endpoint — so the
analytics-summary `allTimePnlValue` staying netDeposit-based is not a DISPLAYED divergence. Honest
cost-unknown treatment preserved: none-cost assets (`avgCost === null`) are EXCLUDED from P&L, never
treated as $0 cost (which would overstate gains).

**Known residual (out of scope, by spec).** The analytics-summary endpoint's `allTimePnlValue` is still
the netDeposit-based number for manual. It is Pro-gated and NOT the displayed headline; the spec scoped
Issue 1 to the `/portfolios` summary field and required the analytics suite green. A future retrofit can
unify it (and update tests 326/327/328) if that endpoint ever surfaces an all-time figure.

## Issue 2 — duplicate wallet+chain connect → 409 (option a, recommended)

Connecting the SAME wallet+chain as two portfolios made the overview DOUBLE-COUNT its value (net worth
~doubles) while `transactionCount` deduped the wallet to one on-chain total — an inconsistent, misleading
aggregate. Chose the clean validation (option a) over reconciling the aggregate (option b): a `409
WALLET_ALREADY_CONNECTED` in `createPortfolio`'s connected branch, after the wallet-format check, before
`createPortfolioRow`. New repo helper `findConnectedPortfolioByWallet(userId, walletAddress, chainId)`
(indexed on `walletAddress`). Match is on the NORMALIZED address (EVM lowercased by the validator) so a
case-variant duplicate is still caught; `chainId` is part of the match so the SAME address on a DIFFERENT
chain is allowed (a genuinely separate holding). Error `details` carry `chainSlug` +
`existingPortfolioId`/`existingPortfolioName` for the frontend. No schema change (no unique constraint
added — would reject legacy duplicate rows on migrate; the service-level guard is sufficient and
reversible). The overview's own `transactionCount` wallet-dedupe (retrofit-74) is unchanged.

## Note — FE-only audit item (no backend change)
Import-CSV modal now surfaces per-row server rejections: `api.ts` `ApiError` carries the response `data`
and the modal merges `data.errors[]` into the preview. The bulk endpoints already return `{ error, data:
{ errors[] } }` — contract unchanged.

## Validate (all green)
- `tests/overview.test.ts` `r88-issue1`: manual w/ a cost-unknown lot → `/portfolios.pnlAllTimeValue`
  === `allTimePnlValue` === overview per-portfolio P&L (3000), and `!=` the `value − netDeposit` phantom
  (3416.30); `pnlAllTime` 3.33% over cost basis.
- `tests/portfolios.test.ts` `r88-issue2` ×2: duplicate wallet+chain (case-insensitive) → 409
  `WALLET_ALREADY_CONNECTED`, only the first row written; same wallet on a different chain → 201.
- Existing portfolios / overview / analytics / snapshots / assets suites: 146 passed / 1 skipped (#300
  TimescaleDB gate). `npm run typecheck` clean.
- `tests/wallet-preview.test.ts` `r65-pro` updated (23/23): it created TWO connected portfolios with
  the SAME wallet+chain to prove per-portfolio resync-cooldown independence — now a 409, so p2 uses a
  distinct wallet. The cooldown key is per-portfolio-id, so the test's intent is unchanged.
