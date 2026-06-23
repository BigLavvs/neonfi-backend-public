# Neonfi data-accuracy audit — 2026-06-19

Live audit of the running app (account `demo3@neonfi.test`, Pro) via Claude in Chrome, every
displayed value cross-checked against external ground truth.

**Wallet audited:** `0xcB1C1FdE09f811B294172696404e88E658659905` (ETH chain), connected portfolio
"Portfolio 2" (id 17) + manual "My main" (id 15, holds 4 USDT).

**Ground-truth sources**
- Prices / 1h-24h-7d changes: CoinGecko API (live, 2026-06-19).
- On-chain ETH balance + tx count: public Ethereum RPC (`ethereum-rpc.publicnode.com`).
  - `eth_getBalance` → **0.005648428679969236 ETH** (app shows 0.00564843 — accurate ✓).
  - `eth_getTransactionCount` → nonce **342** (outgoing).
- App values: the app's own authenticated `/api/v1/*` payloads + rendered UI.

**Key reference prices (CoinGecko, 2026-06-19):** ETH **$1,699.27** (1h −0.17% / 24h +0.59% /
7d +1.90%); PEPU (pepe-unchained) **$0.00002421**; MCO2 (moss-carbon-credit) **$0.080939**;
USDT $0.99908; BUSD $0.99971; HEX $0.00046743; APE $0.12911.

---

## CRITICAL

### C1 — All-time PnL is structurally wrong (shows ≈0 / green; reality ≈ −95%)
- **Displayed:** Dashboard "ALL-TIME PNL" flips between **+0.02% / +$0.0028** and **+2.59% / +$0.42**
  between loads; Performance "ALL-TIME P&L" **+$0.0012 / +0.0%** (all green).
- **Reality:** `/overview` returns `pnlAllTimeValue: -292.87` (**pnlAllTime −94.76%**). The portfolio's
  recorded value fell from ~$306 (oldest snapshot) to ~$12.6 today.
- **Root cause:** `overview.service.ts:271` `allTimePnlValue = unrealizedPnlValue + realizedPnlValue`.
  Connected wallets have no cost basis → both are 0 → `allTimePnlValue = 0`. The UI displays this
  field, then the frontend's "live recompute" adds `(liveTotal − snapshotTotal)`, so the headline is
  pure **price-staleness noise** (the +$0.42 is exactly the stale-ETH gap — see C2). The genuinely
  computed `pnlAllTimeValue` (−$292.87) is returned but never shown.
- **Impact:** Users are told they're flat/up when the portfolio is down ~95%. Highest-severity.
- **Fix:** Decide one definition. Display `pnlAllTimeValue`/`pnlAllTime` (value-vs-baseline) when no
  cost basis exists, or show "—" — never a near-zero number driven by live-price jitter. Reconcile the
  three fields (see C1b).

### C1b — Three conflicting "all-time" fields in one payload
`/overview.totals` simultaneously returns `pnlAllTimeValue: -292.87`, `pnlAllTime: -94.76`,
`allTimePnlValue: 0`, `unrealizedPnlValue: 0`, `unrealizedPnlPct: 0.01`. The DTO ships all of them; the
UI happens to read the one that's 0. Collapse to a single source of truth.

### C2 — Two different ETH prices used inside one `/overview` response
- **Displayed:** Dashboard total renders **$16.62** on load, then WS corrects to **$16.20**; donut ETH
  **60.24%**; allocation rows sum to **$16.62** but the center total says **$16.20**.
- **Root cause:** within the same response, per-portfolio `totalValue` is computed from **live** token
  prices (ETH ≈ $1,698 → connected $12.21) while `allocation`/`holdings` values use the **stale daily
  snapshot** price (ETH $1,772.85 → connected $12.62). Gap = 0.00564843 ETH × ($1,772.85 − $1,698.58)
  = **$0.42**, exactly the allocation-vs-total mismatch.
- **Impact:** Total value is non-deterministic across loads/pages; donut slices don't sum to the total.
- **Fix:** Value `totalValue`, `allocation`, and `holdings` from the **same** price source.

### C3 — Stale + duplicated daily price snapshots
- **Evidence:** `/tokens/2/history?days=30` matches CoinGecko for May (05-21 = $2,127.29 ✓) but the last
  two points are **identical and stale**: 2026-06-18 = 2026-06-19 = **$1,772.85**, vs CoinGecko's real
  06-19 **$1,698.58**. `token.currentPrice` is live ($1,697.92) — so only the daily snapshot is stale.
- **Impact:** Drives C2 (overvaluation) and C7 (bogus −4.25% token change). The daily snapshot job is
  either not running or carries the previous price forward.
- **Fix:** Ensure the daily close writes the real day's price (no carry-forward duplicate); don't value
  holdings off a stale daily row when a live price exists.

### C4 — PEPU mispriced ~3.7×
- **Displayed (live, `/portfolios/17/assets`):** PEPU **$0.00009067**.
- **Reality:** CoinGecko pepe-unchained **$0.00002421**.
- **Impact:** PEPU holding shown as $0.41 vs real ~$0.11; not staleness — the resolver's PEPU price
  itself is wrong (likely a wrong symbol→id mapping or dead source). Verify the PEPU contract on this
  wallet maps to the correct CoinGecko/Moralis id.

---

## HIGH

### H5 — "24H PnL −90.43%" is measured against a 4-day-old baseline
The connected portfolio has **no daily snapshots** — points are ~4 days apart (sampler spacing):
…06-07, 06-11, **06-15 = $169.31**, **06-19 = $12.62**. `findSnapshotNearDaysAgo(id,1)` picks 06-15, so
"24H" actually spans 4 days and reports −90%. Real 24h move is ≈ flat (ETH +0.59%). Fix: require a true
~24h-old point, else show "—"; run a real daily snapshot job.

### H6 — Token "View analytics" link 404s from the aggregated view
`wallet/+page.svelte:288` `portfolioSlug = selectedPorts[0]?.name…` — always the **first/selected**
portfolio (manual "my-main"). ETH lives in the connected portfolio, so the link goes to
`/wallet/my-main/eth` → **"404 Asset not found."** Fix: use the slug of the portfolio that actually holds
the asset, and use the real `slug` field (not a name-slugified guess).

### H7 — Token-detail headline change is wrong (−4.25% vs real +0.59%)
ETH analytics header shows **−4.25%**, which is `(live $1,697.52 − stale daily $1,772.85)/$1,772.85`.
Real 24h is **+0.59%** (CoinGecko). Caused by C3. The wallet table's 24h badge (+0.51%, from the WS
firehose) is correct — so the two surfaces disagree for the same token.

### H8 — Token all-time PnL contradicts "no cost basis"
ETH analytics shows **All-time PnL −$4.65 / −32.67%** while the same card shows **"Average buy price —"**
and **"Total invested $0.00."** The −32.67% is a price-return proxy (retrofit-64) mislabeled as the
holding's PnL. If there's no basis, PnL should be "—", not a dollar figure.

### H9 — Deposits ($3.41) ≪ Withdrawals ($516.38); inflows not captured
Performance shows Total Deposits **$3.41**, Total Withdrawals **$516.38**. Every ETH transaction is
imported as a **SELL** (6 sells, no buys) — the connected-wallet import is capturing outflows but not the
matching inflows, so cost basis is $0 and deposit/withdrawal/PnL math is unusable. Root of C1's $0 basis.

### H10 — "Total Transactions 421" vs 17 actually present
`totals.transactionCount` uses the connected wallet's on-chain `externalTxCount` (**421**), but the app
has imported **17** transactions (16 connected + 1 manual; the list endpoints return 17). The headline
number can't be reconciled with the visible list. Either label it "on-chain transactions" or count
imported rows.

### H11 — Connected value-history is inflated/unreliable
292 snapshots back to 2023-06 with values like **2023-07-08 $349.95 → 2023-07-12 $2,933.96** and
May/Jun 2026 at **$169–228**, while the wallet's real current value is **~$12** (ETH 0.0056 verified
on-chain at ~$1,699 + ~$2.6 tokens). ETH's price was steady ~$1,700 across the period, so the wallet
was never worth $200+ with these balances — the Moralis historical sampler is over-valuing (likely
spam-token "usd_value"). The dashboard chart's $214→$12 cliff is therefore an artifact, not a real loss.

---

## MEDIUM

### M12 — Per-portfolio PnL rows are meaningless
Performance "PnL by percentage" shows **My main +2.59%, Portfolio 2 +2.59%, Total +2.59%** — three
identical numbers; "PnL by value" splits the **$0.42** live-price artifact by weight ($0.104 / $0.316).
A just-created manual USDT portfolio and a −95% connected wallet cannot both be +2.59%.

### M13 — ETH allocation shown three different ways
Dashboard **60.24%**, wallet table **59%**, token page **79%**. The 79% is computed against the single
connected portfolio but labeled **"ETH makes up 79% of your total portfolio value."** Pick one basis and
label it correctly.

### M14 — Net worth differs across pages
Same instant: dashboard **$16.62** (stale, on load) vs performance **$16.20** vs wallet **$16.19592**.
All three should agree.

### M15 — "ASSETS 11" counts zero-balance/dust tokens
Wallet header says **11 assets**; only ~7 have value. The connected portfolio carries zero-balance rows
(STETH, YIELDX, FAM, ASTETH) and dust (APE 8.2e-7 ≈ $0). Overview's per-portfolio `assetCount` (6+1)
disagrees. Filter balance>0 (or a dust threshold) consistently.

### M16 — 24h total ≠ sum of portfolios
`totals.pnl24hValue −153.11` vs Σ portfolio 24h **−157.10** (connected −157.10, manual 0). The
~+$4 delta ≈ the manual portfolio's value — a portfolio created **today** appears to contribute a
phantom +$4 "24h gain" (no 24h-ago baseline → treated as 0→$4).

### M17 — NFT transactions render as asset "nft", +$0.00
Recent-transactions list shows rows literally labeled **"nft" / Buy / +$0.00**. NFT transfers should
show the collection/name (or be excluded from the token transaction feed), not a placeholder symbol.

### M18 — "Top Movers Today" shows tokens the user doesn't hold
ESPORTS (Yooldo), MET (Meteora), GUA (SUPERFORTUNE), UB (Unibase), LAB, O (o1.exchange), VELVET — these
are **real catalog tokens** (verified), but **none are in the portfolio** (ETH/USDT/BUSD/PEPU/MCO2/HEX/
APE). The dashboard's "Top Movers Today" surfaces market-wide movers unrelated to the user's holdings,
under a label that implies they're the user's. Scope to held assets, or relabel "Market movers."
(Correction to the first-pass note: these are not garbage/spam — they're legitimate tokens, just irrelevant.)

---

## LOW

- **L19 — Empty meta rows:** token detail renders "Average buy price" / "Total invested" with blank/
  $0.00 for connected tokens (same empty-row class fixed on the NFT modal).
- **L20 — Minor price drift:** MCO2 $0.0813 vs $0.080939 (+3%); USDT shown $1.00 vs $0.99908; HEX value
  rounds to **$0.00** (1 HEX = $0.00047) so a real holding reads as worthless.
- **Note:** 56 NFTs reported for the wallet — likely includes airdropped spam; none are valued/filtered.
- **Not a bug:** `/performance` was briefly blank on navigation but renders within a few seconds (slow
  first paint, not a crash).

---

## ROUND 2 — deeper dig (additional findings)

Second pass: all 7 token pages (via API), ATH/ATL, NFT tab (56 items), Payments, Settings, every chart
range. ~13 more issues; several are systemic.

### C5 — ATH / ATL are trailing-365-day extremes, mislabeled "All-Time"
ETH analytics shows **ATH $4,829.23 · ATL $1,568.7661**. CoinGecko's true ETH **ATH = $4,946.05** and
**ATL ≈ $0.43**. The displayed "ATL" is exactly the 30/365-day chart low. So "All-time high/low" is
really the fetched-window high/low. For the 2-point tokens (below) ATH/ATL are just max/min of two stale
points (e.g. MCO2 "ATL $0.0734" = yesterday's stale value, "ATH $0.0812" = today). Mislabels every token.

### C6 — Auto-listed wallet tokens have only **2** price-history points (fabricated analytics)
`/tokens/:id/history?days=365` returns **n=2** for BUSD, PEPU, MCO2, HEX, STETH, ASTETH (just today +
yesterday, often duplicated/stale), vs **n=366** for real catalog tokens (ETH, USDT, APE). Consequence:
the price chart, every %-change window (1H/24H/7D/1M/1Y), ATH/ATL, and all-time PnL for **all
connected-wallet-discovered tokens** are computed from 2 points — i.e. fabricated. Example: MCO2 history
last point $0.0734 while its `currentPrice` is $0.0812.

### C7 — Token "all-time PnL" baseline = price **365 days ago**, mislabeled "all-time"
ETH page "All-time PnL −32.67%" = (live $1,699 − price on 2025-06-19 $2,521)/$2,521. It's a trailing
1-year price return, not a lifetime PnL, and (per H8) it's shown even though the holding has no cost basis.

### C8 — `currentPrice` ≠ latest daily history point (same token, same response)
ETH `currentPrice` $1,699.67 vs history-last $1,772.85; MCO2 $0.0812 vs $0.0734. The "current price",
the daily snapshot used for valuation, and the chart's right edge are three different numbers.

### H12 — All 56 NFT floor prices + last sales are **null** (zero NFT valuation)
Every NFT returns `floorPrice: null`, `floorPriceUsd: null`, `lastSale: null`. The NFT section therefore
has no valuation at all and "Floor Price"/"Last Sale" are always blank — the earlier "hide empty meta
rows" fix masks that **none** are ever populated. NFTs contribute $0 to net worth with no indication.

### H13 — No NFT spam filtering (spam shown as holdings)
The 56 NFTs include **"Hefty Presents" ×17**, "Garbage Bags" ×2, **3 with a null collection name**, and
unicode-obfuscated names ("ᴀʟʟ-ɪɴ 852 ɢᴀʀᴅᴇɴ"). Classic airdropped spam, surfaced as the user's assets
with no filter/spam score. **10/56 also have no image** (placeholder tile).

### M19 — Payments: "No payments yet" despite an active paid subscription
Payments shows **Pro · Active, $20/mo, card on file, renews Jul 16 2026**, and the API has a live Stripe
sub (`sub_…`, period 2026-06-16 → 07-16) — yet **Payment History is empty**. An active paid plan should
have at least the initial charge recorded.

### M20 — Net-worth value is unstable across loads/pages
Same wallet, minutes apart: **$16.19592** (wallet) · **$16.201204** (performance) · **$16.202772**,
**$16.21668**, **$16.215177**, **$16.62** (dashboard, varies by load). Caused by C2/C3 (live vs stale
price mixing); the headline number visibly flickers.

### M21 — Aggregate `valueHistory` ignores manual portfolios
For ALL, server `valueHistory` is byte-identical to `connectedValueHistory` (both n=292, both start
2023-06-23 $306 → today $12.62). Manual portfolios have no snapshots, so the server-side historical line
omits them entirely (they appear only via the frontend reconstruction). And the ALL chart still opens on
the inflated 2023 sampled value (see H11).

### L22 — Slow page transitions
`/performance` and `/settings` render blank (or briefly show the dashboard) for ~3–5s before painting —
the route loaders block first paint. UX, not data, but noticeable.

### Not bugs (checked, ruled out — for honesty)
- **Current holdings are accurate:** ETH balance 0.00564843 matches on-chain exactly; USDT/BUSD/HEX/APE
  prices are within ~0–1% of CoinGecko.
- **ETH transaction "price at time" is ~right:** Sep-15-2025 $4,527 vs real $4,610; Oct-15-2025 $4,005 vs
  real $4,129 (≈2–3%, daily-close vs intraday timing). Fine for catalog tokens (would be wrong for the
  2-point tokens in C6).
- **`/performance` is not broken** — just slow (L22).

---

## ROUND 3 — backend root causes + behavioral (even deeper)

Code-level cause for each systemic finding (exact refs), plus live tests of the transactions ledger and
a non-catalog token page.

### Root causes
- **C2/C3 (stale valuation):** two price stores that drift — `Token.currentPrice` (CMC catalog sync) vs
  the live Redis tick `price:<SYMBOL>` (resolver). `/overview` values allocation/holdings off
  `Token.currentPrice`; wallet/token pages use the Redis live price (ETH $1,772.85 vs $1,699). The daily
  `token_price_snapshot` copies `Token.currentPrice` (`snapshot.job.ts:178-190`), so the chart's last
  point inherits the stale value and 06-18≈06-19 duplicate when the catalog didn't refresh between runs.
- **C4 (PEPU 3.7×):** auto-listed tokens take the provider's price verbatim — `sync.ts:145`
  `currentPrice: t.usdPrice != null ? dec8(t.usdPrice) : '0'` (Moralis's wrong $0.00009), no validation
  against a canonical feed; CMC doesn't cover PEPU so it's never corrected.
- **C5 (ATH/ATL):** `tokens.service.ts:78` — "high/low **SINCE TRACKING BEGAN** (min/max over ALL
  snapshots)". Snapshot-window extreme, mislabeled "all-time".
- **C6 (2-point history):** `token_price_snapshot` accrues one row per token per day the job runs;
  auto-listed tokens (high ids: PEPU 1529, BUSD 1528, MCO2 1530, HEX 1531, STETH 1532, ASTETH 1533) were
  created ~2 days ago with **no historical backfill** → n=2. Catalog tokens (ETH 2, USDT 3, APE 191) were
  seeded/backfilled → n=366.
- **H12 (NFT floor):** Moralis `/{address}/nft` (`sync.ts` getNftHoldings) returns metadata only — no
  floor. `Nft.floorPrice/floorPriceUsd/lastSale` are never written → null for all 56.
- **M18 (movers):** `overview.service.computeTopMovers` ranks ALL catalog tokens with a live tick by
  |24h|, top 6 — global, never intersected with the user's holdings.

### Behavioral — transactions ledger (Wallet ▸ Transactions, 17 rows)
- **R34 — AMOUNT has no directional sign:** every row renders **+$** (green), including sells ("Sold
  0x59e1…e547 … **+$10.315663**", "Sold … **+$274.94429**"). The dashboard signs the same sells **−$**.
  Inconsistent; the ledger implies everything is an inflow.
- **R35 — Spam transfers imported as transactions:** "**0 FAM** Bought +$0.00", "**44.23575 YIELDX**
  Bought +$0.00" — zero/worthless spam airdrops listed as the user's transactions.
- **R36 — NFT transfers in the token ledger:** rows with token "**nft**", amount "**—**", **+$0.00**,
  counterparties 0x0000…0000 (mint) and the user's **own** address.
- **R37 — Cost basis dropped even when a BUY exists:** PEPU shows a recorded **BUY $0.4134** yet "Total
  invested **$0.00**" / "Average buy price —". The connected import classifies ETH/STETH almost entirely
  as **Sold** with no buy legs → Deposits $3.41 (only USDT+PEPU buys) vs Withdrawals $516.38. Root of the
  broken cost basis (C1/H9).

### Behavioral — non-catalog token page (PEPU)
- **R38 —** the **1M/3M/1Y chart shows only 2 points (Jun 18–19)**; price $0.00009 (real $0.0000242);
  "ATH $0.00009 / ATL $0.00008626" are just those two points; "All-time PnL +4.38%" with $0.00 invested;
  allocation "3%" is portfolio-scoped but labeled "total". C4/C5/C6/H8/M13 all visible on one screen.

---

## ROUND 4 — analytics endpoints + write-action tests

### Analytics endpoints (read-only, new contradictions)
- **R39 — Manual portfolio all-time PnL is spurious + inconsistent across 3 endpoints.**
  `/analytics/15/summary` reports the **USDT-only** "My main" at **+$1 / +33.34%** — impossible for a
  stablecoin-only portfolio. Cause: the opening 1 USDT isn't counted in net deposits (deposits $3 vs
  value $4 → fake +$1). The same portfolio's all-time reads **$0** in `/overview` and **+$0.10** on
  Performance. Three endpoints, three different numbers for one portfolio.
- **R40 — The correct connected all-time IS in the API but unused.** `/analytics/17/summary` =
  **−96.01% / −$293.86** (matches `/overview.pnlAllTimeValue`), yet the dashboard/Performance hero shows
  ~$0. Definitive proof the data exists and the UI binds the wrong field (C1). 7d/30d there are −92%/−94%
  (stale-baseline + inflated-history across every window).
- **R41 — ETH allocation now has FOUR values** across surfaces: 78.64% (`/analytics/17/holdings`,
  portfolio-scoped) · 79% (token page) · 60.24% (dashboard donut, all-portfolios, stale price) · 59%
  (wallet table, all-portfolios, live price). (Sharpens M13.)
- **R42 — Deposits/withdrawals confirmed at source:** connected deposits **$0.41** vs withdrawals
  **$516.38**; manual deposits **$3**, withdrawals $0.

### Write-action tests (user-authorized; state restored afterward)
- **Resync** `POST /portfolios/17/resync` → 200 in 8.7s, `{importedTransfers:0, reconciled:9}`; value
  unchanged ($12.22), snapshots still 292 → **resync is incremental** and will NOT repair the inflated
  history (only a full re-import would).
- **Cooldown (retrofit-65) verified LIVE:** immediate 2nd resync → **429 RESYNC_RATE_LIMITED**, "every
  5 minutes", `retryAfter 274` (present in both `error.details` and `meta`). ✓ My round-1 fix works.
- **Manual transaction pipeline is sound:** logged a buy (0.01 ETH, $16.98) → deposits $3→$19.98 and PnL%
  recomputed to 5.16% correctly; then **deleted it** → fully restored ($3, 1 tx). So the
  cost-basis/PnL/delete engine is correct — **the cost-basis breakage is isolated to the connected-wallet
  import**, not the engine. (Narrows the C1/H9 fix to the importer.)
- **Transfer:** not testable on this account (cross-portfolio transfer needs 2 manual portfolios; only 1
  exists). No bug observed; flagged as untested.

---

## ROUND 5 — security, balance accuracy, input validation (even deeper)

New classes probed: authorization/IDOR, XSS, on-chain balance verification, write validation. Mostly
**positives** (core infra is sound) plus 3 new validation bugs.

### Confirmed SOLID (ruled out — matters for a production-readiness call)
- **No IDOR — authorization enforced:** `/portfolios/:id` and `/analytics/:id` for ids the user doesn't
  own return **403** with no data; own ids 200. (First-pass 401s were just an expired access token —
  corrected after `/auth/refresh`, then non-owned cleanly 403.)
- **No XSS from attacker-controlled data:** the only `{@html}` in the entire frontend is `Sidebar.svelte`
  rendering hardcoded SVG icon paths. NFT names/descriptions/notes (on-chain, attacker-controllable)
  render as escaped text — safe.
- **Token balances accurate on-chain (not just ETH):** eth_call `balanceOf` — BUSD 2.10214389 ✓,
  APE 8.17996e-7 ✓, HEX 1 ✓ — all match the app.
- **Write validation mostly works:** negative amount → 400, negative price → 400, unknown symbol → 400,
  manual write to a **connected** portfolio → 403 `CONNECTED_PORTFOLIO_READ_ONLY`, oversell → 400
  `INSUFFICIENT_BALANCE`.

### New validation bugs
- **R43 — Zero-amount transaction accepted:** POST buy `amount:0` → **201** ($0 usdValue). A no-op should
  be rejected (amount must be > 0).
- **R44 — Huge amount → 500 INTERNAL_ERROR:** POST `amount:999999999999999` → **500** (not 400). Exceeds
  Decimal(20,8); the DB throws instead of the request being validated → unhandled server error.
- **R45 — Future-dated transaction accepted:** POST `timestamp:2099-01-01` → **201**. A transaction 73
  years in the future is stored, corrupting value-history reconstruction + the chart x-axis. No upper
  bound on the timestamp.

(All probe rows were created then deleted; state restored.)

---

## Suggested fix priority
1. **C1/C1b** unify all-time PnL (stop showing ~0/green for a −95% portfolio).
2. **C2/C3** one price source for total/allocation/holdings; fix the stale+duplicated daily snapshot.
3. **H9** capture inflows in the connected-wallet import (fixes cost basis → C1, H8, deposits).
4. **C4** fix PEPU (and audit every symbol→price mapping).
5. **H5 + H11** real daily snapshots + sanitize the historical sampler (spam-token valuations).
6. **H6/H7/H10/M12–M18** the per-surface display bugs above.
7. **C6** backfill real price history for auto-listed wallet tokens (2-point history → all their charts/changes/ATH-ATL/PnL are fabricated).
8. **C5/C7/C8** correct ATH/ATL + "all-time" labels (window vs lifetime); reconcile currentPrice ↔ daily snapshot ↔ chart edge.
9. **H12/H13** populate NFT floor/last-sale (or hide the section), and filter NFT spam.
10. **M19** record payments for active subscriptions.

**Tally:** ~46 distinct findings — C1–C8 critical, H5–H13 high, M12–M21 medium, L19/L22 low, R34–R45
behavioral/cross-endpoint/validation, plus round-3 root causes and round-4/5 live verification. Confirmed
SOLID: authorization (no IDOR), no XSS, on-chain balances, and most write validation + the transaction
engine itself — so the rot is concentrated in the price/PnL/history/derived layer, not the foundations. Current holdings/balances and catalog-token (ETH/USDT/APE)
prices are accurate; almost everything *derived* — PnL (24h, all-time, per-portfolio, per-token),
allocation %, every %-change window, value history, ATH/ATL, transaction signing/direction/cost-basis,
counts, and all NFT + payment data — is wrong, stale, mislabeled, or fabricated.

The single deepest root: the app trusts **provider/auto-listed prices and one-directional transfer
imports** without a canonical price feed, historical backfill, or buy/sell reconciliation — so every
derived metric built on those inherits the error.
