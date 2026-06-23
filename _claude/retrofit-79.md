# retrofit-79 — Real connected PnL via the provider orchestrator, honest short-term + chart

Supersedes the earlier H11 all-time options (snapshot-delta / DIY net-out / "remove it"). The
connected-wallet PnL gap exists for ONE reason: connected holdings have **no cost basis** (the
transfer import is windowed, so the code deliberately clears cost basis and falls back to
snapshot-delta — which conflates withdrawals with losses, e.g. the live −96% / fake −$203 30d).

**The fix stays multi-provider.** Add **PnL/cost-basis as a capability in the existing wallet-data
orchestrator** — exactly like balances / transfers / value-history — NOT a single-vendor dependency.
Multiple providers expose a turnkey wallet-PnL endpoint with cost basis (confirmed: GoldRush AND
Moralis). For THIS capability the priority is **GoldRush → Moralis** (a per-capability override of
the global Moralis-first chain), because GoldRush returns realized **+ unrealized + cost basis**
across 100+ chains while Moralis is realized-only on ETH/Polygon/Base. Populate connected cost basis
from whichever provider answers (fallthrough), then the EXISTING cost-basis PnL path (the one manual
portfolios use) yields a real all-time + per-token PnL, and fixes the token page ("Total invested
$0.00") for free.

## Pre-flight history-completeness audit (done 2026-06-20 — read before building)
Confirmed the codebase never derives a DISPLAYED connected number from the windowed history; this
retrofit must preserve that discipline. Verified safe:
- balance ← provider summary, not txns (`recalc.ts` returns early for connected, ~L45-55);
- avgCost/costBasis/realizedPnl/netDeposit ← **cleared** for connected (`setConnectedBalancesFromSummary`
  sync.ts ~585-628); recalc never recomputes from the window;
- all-time ← snapshot-delta, NOT `value − netDeposit` (derive.ts ~137 `computeConnectedDerived`), so
  the cleared `netDeposit=0` can't surface as +100%;
- 24h/7d/30d ← snapshots; deposits/withdrawals ← **null/"—"** for connected (analytics.service ~L87);
- transactionCount ← provider `externalTxCount` (real on-chain total), not the imported window.

Two integration points this retrofit MUST hit (otherwise provider cost basis won't actually drive
the UI), and one minor edge — see §1 and §5.

## What our providers offer for PnL (verified against docs, 2026-06)
- **GoldRush / Covalent** (PnL PRIMARY; `upnlForWallet`, currently **Beta**, no credits charged):
  per-token `cost_basis`, `current_price`, `pnl_realized_usd` **and** `pnl_unrealized_usd`. 100+
  chains. Beta → pin to the fields we use and tolerate schema drift.
- **Moralis** (PnL fallback; GA): `…/wallets/{address}/profitability/summary` + `…/profitability`
  (per-token). Weighted-average cost basis; **realized only** → we derive unrealized from our live
  prices. Chains: Ethereum, Polygon, Base.
- **Alchemy / Ankr**: no confirmed turnkey PnL endpoint → return "unsupported" so the orchestrator
  falls through to "—". (A computed-from-swaps fallback is possible later; NOT in scope.)
- **Trade-based, all providers:** cost basis exists only for tokens actually *bought*; tokens received
  via plain transfer / CEX withdrawal have no on-chain buy price → genuinely cost-unknown → "—".
Docs: GoldRush — https://goldrush.dev/docs/goldrush-streaming-api/upnl-for-wallet ·
Moralis — https://docs.moralis.com/web3-data-api/evm/profitability-faqs

## §0 — PROBE FIRST (hard gate — before building §1)
CC: call each capable provider's PnL endpoint for the demo wallet
(`0xcB1C1FdE09f811B294172696404e88E658659905`, eth) with our keys and paste the raw responses:
- **GoldRush** `upnlForWallet` (primary).
- **Moralis** `…/profitability/summary` + `…/profitability` (fallback).
Confirm per provider: (a) plan/tier access (not 401/402/403); (b) exact response shape + field names
(the mapping reads these, not assumptions); (c) realized/cost-basis look sane (this wallet has real
ETH sells → realized non-trivial). **Need ≥1 provider to pass to build §1.** If none → ship only
§2 + §3 + §4 ("—" for connected all-time).

## §1 — PnL as an orchestrator capability → real all-time + per-token
Add a `walletPnl(address, chain)` capability to the orchestrator, returning a **normalized** per-token
shape regardless of provider: `{ symbol/contract, avgCost, costBasisUsd, realizedPnlUsd, unrealizedPnlUsd? }`.
- **Provider order (this capability): GoldRush → Moralis → (Alchemy/Ankr: unsupported) → none.**
  Per-capability override of the global Moralis-first chain. First usable response wins; on
  error/empty/unsupported-chain, fall through — same pattern as balances/transfers. Never fail sync
  on a PnL miss.
- **Normalize across providers + single source of truth for unrealized:** store cost basis
  (`avgCost`, `costBasis`, `realizedPnlValue`) and let derive.ts compute unrealized from OUR live
  price map, so unrealized is consistent with the rest of the app (provider `unrealized` is a
  cross-check, not the stored value).
- **(Integration point 1) Stop clearing connected cost fields.** `setConnectedBalancesFromSummary`
  (sync.ts ~585-628) currently writes `avgCost:null / costBasis:'0' / realizedPnl:'0'` for connected.
  Replace that with the provider PnL values per token; leave null/0 ONLY for genuinely cost-unknown
  (transfer-acquired) tokens → `costTracked` accordingly.
- **(Integration point 2) Flip the derive.ts connected branch.** `computeFromDb` short-circuits
  `type==='connected'` to `computeConnectedDerived` (snapshot-delta) at ~L137, BEFORE the cost-basis
  path. Change it: when the connected portfolio HAS provider cost basis (avgCost present /
  costBasisSum>0), use the SAME cost-basis path manual uses (the accumulators at ~L122-132 already
  compute unrealized/realized) → all-time = unrealized + realized. Fall back to snapshot-delta/"—"
  only when no cost basis. This is what actually makes provider cost basis drive the displayed PnL.
- `canonicalAllTime` (retrofit-75): connected now resolves to the cost-basis all-time when cost basis
  exists (same branch as manual); snapshot-delta retained only as the §4 fallback.
- Fixes **C7** automatically (token page reads real avg buy price / total invested / PnL).

Refresh: fetch on initial sync + resync; cache the normalized result (changes only on new trades);
one call per wallet per provider attempt — respect rate limits; degrade to §4 on provider error.

## §2 — D1: honest "—" for no-baseline short-term (24h/7d/30d)
Short-term still comes from snapshots (PnL endpoints are all-time/realized, not a daily series).
After retrofit-77/78 a connected portfolio with no real ≤N-day snapshot returns 0 → UI shows
"+0.00%" (flat), implying "no change" when we mean "unknown". Make it honest:
- `derive` `snapshotDelta`/`computeShortTermDeltas`: return `null` (not 0) when there's no
  in-tolerance `approx=false` baseline. Keep totals-exclusion (null portfolio contributes 0 / is
  excluded from the headline, retrofit-75 M16 → `totals == Σ rows` holds).
- DTOs: `pnl{24h,7d,30d}Value`/`…Pct` → `number | null`.
- Frontend (Cowork): render `null` → "—" (neutral) on dashboard cards + per-portfolio rows,
  performance, wallet; a genuine flat real delta still shows "+0.00%".

## §3 — Chart: omit the estimated segment (kill the fake cliff)
The value chart still plots the approximate backfill ($223→$169→$12 cliff) because the value-history
read doesn't filter `approx`. PnL endpoints give a figure, not a daily series, so there's no accurate
history to substitute — omit the estimate:
- connected value-history serves only `approx=false` points (filter the query) OR expose `approx` per
  point so the frontend drops them. Result: real observed history only (grows daily). Honest over
  fabricated. (A true historical series = a separate provider net-worth-timeseries effort — NOT here.)

## §4 — Fallback (no provider returns PnL: plan denied / unsupported chain / no trades)
Connected all-time → "—" (never snapshot-delta's −96%); per-token → cost-unknown "—". If no provider
can give a real number, show none — never a fabricated one.

## §5 — Minor edge found in the audit (cheap, include here)
overview.service.ts (~L283/289): transactionCount uses provider `externalTxCount` for connected, but
**falls back to the windowed DB count when `externalTxCount == null`** (sync gap / portfolio synced
before the field existed) → undercount. Guard: if a connected portfolio has no `externalTxCount`,
show "—"/re-fetch the count rather than the windowed DB number. (Also: `countUserTransactions` is
dead code — defined, never called — safe to delete.)

## §6 — Connected "Total invested / Realized" (fills the deposits/withdrawals slot, was "—")
Literal connected deposits/withdrawals stay "—" — summing a windowed, one-directional transfer
ledger (airdrops / spam / internal moves all look like "deposits") is misleading. But the §1 PnL
breakdown already gives the meaningful equivalent for FREE, so show it instead of a blank:
- **Total invested** = the provider's total USD cost basis put in (use the provider's
  total-invested / total-bought field if it includes since-sold lots; else Σ current
  `Asset.costBasis` as the floor).
- **Realized** = the provider's realized PnL (Σ per-token `realizedPnl`, already persisted in §1).
- `analytics.service.ts` (~L87): for connected, stop returning `null` deposits/withdrawals — return
  new `totalInvested` / `realizedPnl` fields from the §1 cost-basis data (null only when there's no
  provider PnL, §4). MANUAL portfolios keep Deposits/Withdrawals (their real logged ledger) unchanged.
- DTO: add `totalInvested: number | null`, `realizedPnl: number | null` (or reuse the existing
  realized field if the summary already carries one).
- This is genuinely free once §1 lands — it's the same breakdown data, just surfaced.

## Frontend follow-ups (Cowork, after CC ships the backend)
- Render the new nulls as "—" (D1 short-term; all-time "—" fallback).
- Token page (C7) largely auto-fixes via real cost basis; keep a "—" branch for still-cost-unknown
  tokens ("cost basis unknown").
- Chart: nothing if backend filters `approx`; else drop `approx` points client-side.
- Performance page (§6): for CONNECTED portfolios render "Total invested / Realized" in place of the
  Deposits/Withdrawals pair; manual keeps Deposits/Withdrawals; "—" when null.
- (Housekeeping) commit the existing uncommitted frontend changes first.

## Validate
- §0 probe: GoldRush (and Moralis) reachable on our plan; wallet realized + cost basis sane.
- Orchestrator: GoldRush primary; force a GoldRush miss → Moralis serves the same wallet (fallthrough);
  both unsupported → "—".
- Integration: a connected portfolio with provider cost basis shows real avg buy / invested / all-time
  on dashboard + token page (cost-basis path, NOT snapshot-delta); all-time == realized + our-unrealized.
- Transfer-acquired token stays "—"; netDeposit stays out of connected all-time.
- D1: fresh connected 24h/7d/30d = "—"; `totals == Σ rows` with a null portfolio.
- Chart: no fake cliff; only real points. §5: connected with null externalTxCount → "—", not windowed.
- §6: connected performance shows real Total invested / Realized (from provider); manual still shows
  Deposits/Withdrawals; both "—" when no provider PnL.
- Suites green (overview/analytics/snapshots/wallet-data); add: per-provider PnL→cost-basis mapping
  (mock each provider), GoldRush→Moralis fallthrough, derive connected cost-basis branch, null
  short-term, §4 fallback, §6 invested/realized for connected.

## Suggested order
§0 probe (GoldRush + Moralis) → §1 capability (GoldRush + Moralis adapters, normalized; stop-clearing
+ derive branch flip) + §6 (rides on §1's data) + §2 + §3 + §5 → Cowork frontend. §2 + §3 + §4 + §5
are provider-independent and can land first for the immediate honest "—"/no-cliff state while §1
(and §6, which depends on it) is built.
