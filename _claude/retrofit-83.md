# retrofit-83 — COLLECT the wallet PnL % from the provider (don't compute it)

Correction to my earlier approach: the providers return a wallet-level PnL **percentage** directly.
We should read it, not reconstruct a denominator. retrofit-80 set the connected all-time % to "—"
and retrofit-83 (v1) tried to derive a lifetime-invested denominator — both wrong. Just collect the
provider's number.

## What the provider gives (verified, Moralis docs)
`GET /wallets/{address}/profitability/summary` returns, at the WALLET level:
```
{
  total_count_of_trades, total_trade_volume,
  total_realized_profit_usd:        "-20653.12...",
  total_realized_profit_percentage: -1.3501773...,   // ← the wallet PnL %, already computed
  total_buys, total_sells,
  total_sold_volume_usd, total_bought_volume_usd
}
```
So `total_realized_profit_percentage` IS the all-time PnL % — collect it. (We already call the
per-token breakdown for cost basis in retrofit-79; we just never read the SUMMARY's % field.)
Docs: https://docs.moralis.com/web3-data-api/evm/reference/wallet-api/get-wallet-profitability-summary

## §0 — probe both providers' SUMMARY (gate)
- **Moralis** summary → confirm `total_realized_profit_percentage` (+ `total_realized_profit_usd`) for
  the demo wallet. (Was 401 free-plan quota — confirm tier/quota; this is the % source.)
- **GoldRush** — check whether its API exposes a WALLET-level PnL summary/percentage (the per-token
  `upnlForWallet` we use doesn't give a wallet %). If it does, it's the primary; if not, Moralis is
  the % provider. Paste both results.

## §1 — collect + surface the %
- Add `walletPnlPct: number | null` (and `walletРealizedUsd`) to the orchestrator's PnL capability;
  populate from the provider summary (GoldRush wallet-summary if it has one → Moralis
  `total_realized_profit_percentage`). Cache with the rest of the PnL (6h), resync bypasses.
- Persist on the connected Portfolio (or carry through derive) → `pnlAllTime` for connected = the
  COLLECTED provider %, not null, not computed.
- Frontend: the all-time card shows it; drop the live-recompute of the % for connected (we no longer
  derive it). The live VALUE recompute can stay; the % is the provider's figure.

## Consistency to decide (one call — flag for the user)
The provider % is **realized** (Moralis is realized-only). Our current all-time VALUE is realized +
unrealized (+$1,391 = +$1,531 realized − $140 unrealized). So:
- **Option A (cleanest, fully provider-sourced):** connected all-time = the provider summary's
  realized pair — value `total_realized_profit_usd` + % `total_realized_profit_percentage`. Both
  collected, internally consistent. Show current-holdings unrealized as a separate line.
- **Option B:** keep value = realized + unrealized, show the collected realized % beside it, labelled
  "realized %" so the basis is clear.
Recommend A (the % and value then come from the same provider number and can't disagree). Either
way: collect the %, don't compute it.

## §2 — aggregate (manual + connected)
You can't average %s. Combine via the underlying figures the summary already provides:
- VALUE: Σ per-portfolio all-time (already combined today).
- %: Σ realized_usd / Σ bought_volume_usd (or Σ invested) across portfolios — a volume-weighted
  combined %, using the provider's `total_bought_volume_usd` for connected and cost basis for manual.
  Never `currentValue − allTime` as the base (the retrofit-80 negative-base bug).

## Fallback
No provider summary % available (GoldRush lacks it AND Moralis quota down) → "—" (retrofit-80
stands). Drive it off the §0 probe.

## Validate
- Connected all-time % = the provider's `total_realized_profit_percentage` (collected verbatim),
  sign-consistent with its value; never "—" when the summary is available.
- Aggregate % is volume/invested-weighted, never a negative base.
- overview/analytics/derive tests green; mock the provider summary % in the adapter tests.
