# retrofit-60 — Connected value-history provider chain (one-call multi-year first) + feed fallback

For connected portfolios, the value/balance history comes from the most efficient provider available,
falling back gracefully, with the expensive path hard-capped. Also makes the transfer/NFT feed
multi-provider so it isn't Moralis-only. **Run AFTER retrofit-59.** Probe-gated (Zerion/Mobula response
shapes are unverified — same discipline as before). **Manual portfolios untouched.**

## getValueHistory — composition (most efficient source, COMBINED for full reach)
The connected value-history builder returns one series covering the target window (up to ~3 yr, or back
to first activity), composing sources by reach:
1. **One-call multi-year** — Zerion (`getWalletChart`) / Mobula (`/wallet/history`): the whole range in
   ONE call. If either serves the wallet, use it alone (order between them set by the probe).
2. **GoldRush + Moralis, COMBINED** — if no one-call multi-year provider is available, take GoldRush
   `portfolio_v2` for the recent ~1 yr (one call) **AND extend the older tail (>1 yr) with Moralis
   `to_block` sampling** (capped), stitched together → goes past one year. This is the combine.
3. **Moralis-only** — if even GoldRush can't serve the wallet, the whole series is Moralis sampling
   (still capped).
`fetchValueHistory` loops providers first-non-null to pick the step-1 series; the GoldRush+Moralis combine
and the Moralis cap live in the connected value-history builder (Part C).

## Error handling — the standard for EVERY external API call (codebase-wide)
This is not only the value-history chain — it's how **every outbound API call in the app** must behave:
all wallet providers (Moralis/GoldRush/Alchemy/Ankr/Zerion/Mobula) and every method, the Moralis streams
client, the price feeds (CMC/CoinGecko/the resolver), webhook callbacks, and any future external call.

- **Runtime fall-through on any 4xx/5xx.** Every provider method (`getValueHistory`,
  `getTransferHistory`, `getNftHoldings`, `getSummary`) MUST catch any non-2xx response (4xx **and** 5xx)
  plus network/parse errors and return `null` / `{status:'error'}` — never throw out of the orchestrator
  loop. So if Zerion 4xx's, the loop moves to Mobula → GoldRush → Moralis automatically; one provider's
  failure can never break the chain or the sync. (The existing providers already do this; the new
  Zerion/Mobula/Moralis-sampling code must too.)
- **But a 400/422 hit during testing is probably OURS, not the provider's — fix it.** A 400/422 almost
  always means our request shape is wrong (bad param name, body field, path, or a missing required
  field) — exactly like the streams probe (POST→PUT, `chains`→`chainIds`, dropping empty arrays). When
  the probe or a test surfaces a 4xx, **diagnose and fix the request, then re-try**, before accepting the
  fall-through. Only treat a 4xx as "this provider genuinely can't serve this wallet" — 404
  not-found, 401/402 key/credit — once the request shape is verified correct. Don't let a self-inflicted
  400 silently skip a provider that would otherwise work.
- **Audit the existing call sites.** Sweep every current `fetch` to an external API — all wallet
  providers, `moralis-streams-client`, the price resolver/feeds, webhook callbacks — and confirm each
  catches non-2xx + network/parse errors and **degrades or falls through rather than throwing**; fix any
  that don't. Make the whole app consistent now, not just the new providers.

## Part A — config
`src/lib/config.ts`: add `ZERION_API_KEY` and `MOBULA_API_KEY` as optional strings (same pattern as
`GOLDRUSH_API_KEY`/`ALCHEMY_API_KEY`/`ANKR_API_KEY`). The keys are already in `.env` (lines 51–52); they
just aren't in the zod schema yet, so `config.*` can't see them until added.

## Part B — build the one-call providers (probe each shape inline, then implement in the SAME run — no pause)
For the test wallet `0xcB1C1FdE09f811B294172696404e88E658659905` (eth), ~3-year range:
- **Zerion** `getWalletChart` (max period / from–to): one call? point cadence? how far back does it
  actually reach? newest value vs the real ~$12.25? auth + rate-limit shape?
- **Mobula** `/wallet/history?wallet=&from=&to=`: same questions.
- **Moralis** `to_block` balances: is the USD value priced at the **historical** block or at **current**
  price? (Decides whether the Moralis fallback needs a separate historical-price lookup.)
Build each provider's `getValueHistory` parser to the shape you **actually observe** (adapt field/param
names to reality, exactly as you did for streams/GoldRush) and wire it in THIS run — do not pause for
sign-off. Endpoint starting points (confirm via the probe):
- **Zerion** — `GET https://api.zerion.io/v1/wallets/{address}/charts/{period}?currency=usd`, `period=max`
  for full reach. Auth: HTTP Basic with the key as username, empty password →
  `Authorization: Basic base64(ZERION_API_KEY + ':')`.
- **Mobula** — `GET https://api.mobula.io/api/1/wallet/history?wallet={address}&from={ms}&to={ms}`. Auth:
  header `Authorization: <MOBULA_API_KEY>`.

**If any probe call returns 400/422, treat it as our request shape first** (wrong param/body field/path/
missing required field, as with the streams probe) — fix and re-try before recording a provider failure.
Only a verified-correct request that still 4xx's (404 not-found, 401/402 key/credit) counts as "this
provider can't serve this wallet."

## Part C — build providers, compose the series (the combine), cap Moralis
- New `ZerionWalletProvider` + `MobulaWalletProvider` implementing `getValueHistory` (built to the probed
  shape); add to `PROVIDERS` (index.ts) ahead of GoldRush, in the probe-decided order. GoldRush
  `getValueHistory` stays.
- **Composition / the combine:** the connected value-history builder takes the deepest one-call series
  (Zerion/Mobula, else GoldRush). If its earliest point is *later* than the target window start, fill the
  gap `[windowStart, earliest)` with **Moralis `to_block` sampling** and stitch. So GoldRush (recent ~1 yr,
  1 call) **+** Moralis (older tail, sampled) = the full multi-year curve — not either/or.
- **Moralis cap — one ceiling, covers BOTH the combine tail AND Moralis-only:**
  ```ts
  const MAX_MORALIS_VALUE_SAMPLES = 50; // hard ceiling of to_block sample-points per wallet
  ```
  ≤ 50 sample-points total, spread across whatever range Moralis must cover — the older gap in the
  combine, or the **whole ~3 yr when Moralis is the only source** (≈ one point every ~3 weeks, weighted
  denser-recent / sparser-old). One `to_block` call per point (cache as `BalanceSnapshot`). So even the
  worst case — Moralis carrying the entire history — is bounded at ~50 calls (≈50–100 incl. `dateToBlock`),
  one-time. 50 is ample for a 3-yr chart (can't render more than ~100–150 distinct points); raise it only
  if you want finer old data. (If the probe shows `to_block` is current-priced, the bounded historical-
  price lookup happens at those same ≤ 50 dates.)
- Connected backfill calls the builder with the target window up to ~1095 days (3 yr).
- Stitch the newest point to the corrected current balance (retrofit-58 Part 1) so the right edge =
  the headline.

## Part C2 — Resync is INCREMENTAL, never a reset
Resync tops up; it must NOT start over (retrofit-50/58 already keep the cursor — make the rest explicit):
- **Balances / assets:** refresh from the provider summary (current truth) — already done by retrofit-58
  Part 1 / retrofit-59.
- **Transactions:** import only the newest page + dedupe on hash (catch what arrived since the last sync
  or webhook). **Never drop or re-window what the user already loaded** — leave `syncCursor` untouched so
  load-more progress persists.
- **Value history:** the multi-year backfill is **one-time**; resync only tops up the recent snapshots
  (today + any missing recent days), it does NOT re-pull the whole multi-year series.
- Net: nothing the user has loaded (transactions, markers, chart depth) is reset by a resync.

## Part C3 — Chart markers come from the LOADED transactions (visual only)
- Transactions are display-only for *value*, but the loaded transaction set still drives the buy/sell
  **markers** overlaid on the provider value line (existing `buildTransactionMarkers`) — keep them.
- Initial load = newest 100; **Load more** pulls the next-older 100 via the cursor, and so on. As more
  transactions load, **more markers appear further back** on the chart — purely visual, never affecting
  the value line.
- This is mostly the existing behaviour; the change is just to ensure the marker source is the loaded set
  and grows with load-more. That's the frontend pass I (Cowork) handle — no backend change beyond the
  existing load-more.

## Part D — feed fallback (transfers + NFTs no longer Moralis-only)
Implement `getTransferHistory` and `getNftHoldings` on **GoldRush** (Covalent has both endpoints) and on
**Alchemy** where supported, so a wallet Moralis misses still gets a transaction feed + NFTs (balances
already fall back via `getSummary`). Same provider-loop; Moralis stays primary/richest, the others are
fallbacks.

## Part E — "found, but no value history" → ask the user (mirrors the empty-wallet flow)
A wallet can be **found** (current balances exist) yet have **no value history** any provider can supply
— brand-new wallet, unsupported chain, or none of them have it indexed. Handle it like the existing
empty-wallet "add anyway?" prompt:
- **Preview (`previewWallet`):** when `getSummary` is `found`, run a LIGHT history check — try the
  one-call providers only (Zerion → Mobula → GoldRush, first non-null; **no Moralis sampling** at preview,
  it's too heavy). If none returns a series, return a new status **`found_no_history`** (with the summary).
- **Frontend (Cowork):** on `found_no_history`, show the same kind of prompt as the empty case —
  "We found this wallet, but couldn't find any value history for it. Add anyway? Your chart will start
  building from today." If they continue, create as normal.
- **On continue:** the full value-history builder still runs at sync (Moralis sampling included), so it may
  recover history the light preview check missed; if not, the portfolio holds the correct current value
  and the chart builds forward via the daily snapshot job. Either way the user was warned and chose.
- Preview statuses become: `found` | `found_no_history` | `empty` | `invalid`. (The light check only runs
  on a `found` summary, so it adds at most one extra call there — never on empty/invalid.)

## Validate
- Test wallet: value history reaches multi-year via the one-call provider in ONE call; force the Moralis
  path and confirm it stays ≤ `MAX_MORALIS_VALUE_SAMPLES`. Newest point ≈ $12.25.
- A wallet only one provider can resolve still gets balances + a feed + history (degrades, never blank).
- Manual portfolios: byte-identical. Suites green (wallet-data, wallet-preview, overview).

## Out of scope
Manual-portfolio behaviour; the optional frontend headline tweak (now harmless since balances are correct).
