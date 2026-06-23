# retrofit-72 — Connected import: honest deposits/withdrawals, 24h baseline, and de-spammed history

**Audit refs:** H9 (deposits $0.41 vs withdrawals $516.38), R37 (cost basis dropped even when a BUY
exists), H5 ("24H" measured vs a 4-day-old snapshot), H11 (value history inflated — $228 May 2026 vs real
~$12; 2023 swings $350↔$2,934).

## H9 / R37 — deposits/withdrawals are misleading for windowed imports
The connected import classifies on-chain transfers as buy(in)/sell(out) and `/analytics/:id/summary` sums
them into totalDeposits/totalWithdrawals. The import is effectively one-directional here (ETH/STETH almost
all "Sold"), so deposits ($0.41) ≪ withdrawals ($516) — impossible (you can't withdraw assets you never
received). Two acceptable fixes:
- **(preferred)** Treat connected wallets as **no reliable deposit/withdrawal basis** (same stance as
  cost-basis = N/A): on the Performance page for connected-only/aggregate-with-connected, show "—" for
  Total Deposits/Withdrawals (or label "Imported transfers — may be incomplete"), rather than a number
  that implies a complete ledger.
- OR make the import symmetric (capture inflows too) AND value each leg at its historical price, so
  deposits/withdrawals reconcile. (Heavier; only worth it if you commit to full transfer history.)
Either way, do not present $0.41 in / $516 out as fact.

## H5 — "24H" must use a ~24h-old point, not "nearest snapshot"
`computeConnectedDerived` uses `findSnapshotNearDaysAgo(id, 1)`, which returns the closest snapshot —
here the 06-15 point (4 days old) — and labels the delta "24H". Require the baseline snapshot to be within
a tolerance of the target (e.g. |Δ − 1 day| ≤ ~0.5–1 day); if none qualifies, return 0/0 and let the UI
show "—" for that window. Applies to 24h/7d/30d. This needs the daily snapshot job actually running
(below).

## Daily snapshots + H11 — de-spam the historical sampler
- Ensure the daily `BalanceSnapshot` job runs (cron/boot catch-up) so there's true daily granularity;
  the current ~4-day spacing means every short-window PnL is wrong.
- The multi-year backfill (`sampleMoralisValueHistory`, `wallets/:addr/tokens?to_block`) over-values the
  wallet (current real value ~$12 verified on-chain, but snapshots read $169–$2,934). Moralis historical
  token lists include spam/airdrop tokens with bogus `usd_value`. Filter the historical valuation to
  real/non-spam tokens (Moralis `possible_spam` flag + a price-sanity bound) before summing, so the chart
  reflects reality. Cap implausible day-over-day jumps or drop unpriced/spam rows.

## Validate
- Connected Performance: deposits/withdrawals either reconcile or show "—"/“incomplete”, never $0.41 vs $516.
- 24h PnL is "—" when no ~24h-old snapshot exists; not a 4-day delta labeled 24H.
- After a fresh full sync, connected value history tracks ~the real value (no $200+ phantom months for a
  ~$12 wallet); 2023 points aren't wild swings from spam tokens.
- wallet-data + analytics + overview suites green.
