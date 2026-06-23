# Neonfi re-audit verification — 2026-06-20 (after retrofit 69–74)

Live re-check of the running app vs CoinGecko + on-chain (wallet `0xcB1C…905`, account demo3, Pro).

## CONFIRMED FIXED (verified live)
- **C1 — all-time PnL:** dashboard now shows **−94.74% / −$292.83 (red)** (was +0.02% green). The single
  worst bug is fixed.
- **retrofit-74 — transaction count:** headline **421** (the wallet's real total), table paginated (16
  rows + Pro-only load-more); `onChainTransactionCount` removed; type chips All·Native·ERC-20·NFT above
  the table.
- **C2 — one price source:** Σ(allocation) ≈ total ($16.26 vs $16.25, 1¢ rounding); donut reconciles.
- **C3 / prices:** ETH app **$1708.2** vs CoinGecko **$1708.5**; HEX/BUSD/APE/PEPU all match. Live-price
  unification working; no stale $1,772.
- **C4 — RETRACTED (my false positive):** the wallet's PEPU (contract `0x93aa…85d6`) is genuinely
  **$0.0000892** per CoinGecko; the app matches. retrofit-71 verify-by-contract confirmed it. I'd compared
  the wrong same-named token originally.
- **C5 — ATH/ATL labels:** token page shows **"High (1Y) / Low (1Y)"**, not "ATH/ATL".
- **C8 — header change:** ETH token header **+0.04% (live)**, not the stale −4.25%.
- **H9 — connected deposits/withdrawals:** show **"—"** (no fake ledger).
- **M13:** token allocation reads **"of this portfolio"**.
- **M15:** wallet asset count is held-only (**7**, not 11).
- **Balances:** on-chain ETH **0.005648428679969236** == app 0.00564843 (and BUSD/APE/HEX verified earlier).
- **Daily snapshots** are running (06-19 + 06-20, 1 day apart).
- **Frontend (this session):** tx type chips (above the table), Pro-gated load-more, signed ledger (R34),
  null-deposit "—" handling.

## STILL OPEN
- **M16 — 24h PnL phantom (live on dashboard): +$4.03 / +33% (green).** Per-portfolio 24h sums to +$0.04
  (manual 0 + connected $0.04); the extra **+$4.00 is the manual portfolio's value**, counted as a gain
  because it has no 24h-ago snapshot (overview totals: `totalValue − Σ(24h-ago snapshots)`, current
  includes manual, baseline excludes it). → **retrofit-75 §M16** (written).
- **R39 — manual all-time +33%:** "My main" (4 USDT, all cost-tracked, costBasis $3.9955) reads +$1/+33%
  because `Portfolio.netDeposit` is a stale **$3** (retrofit-69's opening-in-netDeposit only re-derives on
  a recalc trigger; existing rows weren't backfilled). → **retrofit-75 §R39** uses the cost-basis number
  for manual (≈0), sidestepping the stale netDeposit.
- **H13 — NFT spam not filtered:** still **56** NFTs incl. "Garbage Bags" / "Hefty Presents". The filter
  relies on Moralis `possible_spam`, which doesn't flag these (and existing rows default false until a
  resync). Needs a heuristic (no floor + airdrop patterns) or a better spam source — Moralis's flag alone
  under-catches.
- **C7 / H8 — token all-time vs $0 invested:** ETH token page shows All-time PnL **−$4.60 / −32.29%** next
  to **"Total invested $0.00" / "Average buy price —"**. For a connected holding (no cost basis) that
  number is a 1-year price return — relabel it (e.g. "1Y price return") or show "—" so it doesn't
  contradict "Total invested $0". (Frontend.)

## Verdict
The flagship correctness problems are fixed and confirmed live — all-time PnL, live/accurate prices,
on-chain-correct balances, real transaction count, reconciling allocation, daily snapshots. Remaining:
two aggregate-PnL edge cases (retrofit-75, written), one NFT-spam provider gap (H13), one token-page label
(C7). No new critical issues found; balances and catalog/live prices are accurate.
