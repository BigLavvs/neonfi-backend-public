# retrofit-86 — NFT spam: fix the provider signal, then a conservative behavioral fallback (H13.1)

retrofit-84 shipped the spam plumbing (combined `Nft.spam` verdict, hidden-by-default + `spamCount`
+ `?includeSpam=true`, `reclassify:nft-spam`, the frontend "Show spam" toggle). But live verification
on the demo connected wallet (Portfolio 2 / P17) shows the **detection under-flags**: after a FULL
resync (which re-runs the complete classifier — confirmed: `resyncConnectedHoldings` →
`importNftHoldings` → `fetchSpamContracts` @ sync.ts:328 + `classifyNftSpam` @ sync.ts:334), only **2
of the obvious spam are caught**, and both only via the NAME heuristic (`.org`/`.net`). The
cross-provider spam-contract signal contributed **zero**.

## Concrete evidence (eth mainnet, after resync)
| Collection | Contract | Held | floor | possibleSpam | spam |
|---|---|---|---|---|---|
| stethaward.org | `0x834bcd951afa5a5d8add63b70ff349aca0688fd4` | 1 | — | false | **true** (name `.org`) |
| BlazeEther.net | `0xca08ef821d0bb913e8566a556a181f3395f84441` | 1 | — | false | **true** (name `.net`) |
| **Garbage Bags** | `0xbdead093d03758772fc2f0dd6d836f0df6bdb6e7` | 2 | — | false | **false** ❌ |
| **Hefty Presents** | `0x248e21b0aa161efe3045e3d067d972cd6a01d1b5` | **17** | — | false | **false** ❌ |

Garbage Bags + Hefty Presents are textbook airdrop spam (bulk copies from one contract, zero floor,
received-not-bought) yet **no provider flags them in our system** — neither Moralis `possible_spam`
nor Alchemy `getSpamContracts`. That is suspicious: these are well-known mass-airdrop collections that
Alchemy usually classifies. So before adding any heuristic, **find out whether our provider signal is
actually working** — fixing a broken call is cleaner and safer (no false-positive risk) than papering
over it with a heuristic.

## Two known defects in the retrofit-84 signal (verified in code)
1. **GoldRush `is_spam` was never wired in.** retrofit-84's doc claimed the union layered in GoldRush
   `is_spam`, but `fetchSpamContracts` (index.ts:141) only unions providers that implement
   `getSpamContracts`, and **only Alchemy implements it** (alchemy.ts:237). So the ENTIRE
   cross-provider spam-contract signal rests on Alchemy alone. Either wire GoldRush's spam flag in or
   strike the claim.
2. **The reclassify backfill is provider-DB-free.** `reclassify-nft-spam.ts:46` marks spam on
   `possibleSpam || isHeuristicNftSpam(...)` only — it never calls `fetchSpamContracts`. So existing
   rows only ever get the name heuristic on backfill; the provider DB applies on the next resync. That
   is by design (network-free backfill) but means the backfill can't catch contract-DB spam — keep in
   mind when picking the backfill path for the new signal.
3. **The live webhook NFT path is name-heuristic-only too.** `moralis-handlers.ts:418`
   (`processNftTransfers`) sets `spam: isHeuristicNftSpam(...)` on each NFT that arrives via a Moralis
   Stream — it does NOT call `fetchSpamContracts` or the behavioral signal. Combined with the fact that
   nothing auto-resyncs connected wallets (only a manual Resync does), a freshly-airdropped spam NFT can
   stay `spam=false` indefinitely. Fix the webhook path to apply the SAME combined verdict as
   `importNftHoldings` (share a per-chain cached spam-contract set so the webhook doesn't refetch it per
   event).

## §0 — PROBE FIRST (gate; decides path A vs path B)
Do NOT build the heuristic until this is answered. Add a tiny read-only probe (a `scripts/` one-off,
like `diagnose-*`, OR a temporary `console.log` in `importNftHoldings`) that, for `{ slug: 'eth' }`:
1. Calls `fetchSpamContracts({ slug: 'eth' })` and logs `set.size`.
2. Calls `alchemy.getSpamContracts('eth')` directly and logs the raw HTTP status + `contractAddresses.length`.
3. Logs whether the set CONTAINS the two missed contracts:
   `0xbdead093d03758772fc2f0dd6d836f0df6bdb6e7` and `0x248e21b0aa161efe3045e3d067d972cd6a01d1b5`.

Interpretation:
- **Empty / tiny set, or non-2xx** → the Alchemy call is broken in our setup (wrong endpoint/version,
  auth, or response shape). → **Path A.**
- **Healthy set (thousands) that INCLUDES the two contracts** → the signal works; the bug is that it
  isn't being applied (e.g., resync didn't refresh `possibleSpam`/spam on UPSERT of existing rows, or
  `contractAddress` casing). → fix the application, re-verify; likely no heuristic needed.
- **Healthy set that EXCLUDES the two contracts** → providers genuinely don't cover them. → **Path B.**

Also confirm against the current Alchemy NFT API docs that `GET /nft/v3/{key}/getSpamContracts`
(returning `{ contractAddresses: [...] }`) is still correct, and whether a `spamConfidenceLevel`
query param is needed to get the full list.

## Path A — fix the provider signal (preferred if §0 shows it's broken)
- Repair the Alchemy `getSpamContracts` integration (endpoint/version, auth, parsing, and the
  `supportsChain`/`isConfigured` gating in `fetchSpamContracts`). Cache the per-chain set (it's large
  and chain-global, not per-wallet) so a resync doesn't refetch it every time.
- Wire **GoldRush** spam into the union too (defect #1): if GoldRush exposes `is_spam` on NFT holdings
  or a spam-contract set, add `getSpamContracts` to its adapter and let `fetchSpamContracts` union it.
- Ensure UPSERT of existing NFT rows REFRESHES the `spam` (and `possibleSpam`) verdict on resync — if
  the upsert only sets spam on insert, existing rows never improve. Verify Garbage Bags / Hefty
  Presents flip to `spam=true` after the fix + a resync.

## Path B — conservative behavioral heuristic (only if providers truly can't cover)
Add a SECONDARY behavioral signal to `classifyNftSpam` (provider flags stay PRIMARY). High precision
is the priority — **hiding a legitimate NFT is worse than showing one spam item** (we already have the
Show-spam toggle as the escape hatch for the spam we do catch).

Candidate signals (combine; require a STRONG combination, not any single one):
- No market value: `floorPrice` null/0 AND no `lastSale`.
- Free acquisition: received via an inbound NFT transfer with **no matching outbound payment** in the
  same tx (airdrop pattern) — we have the transfer rows from `importTransfers` (kind `nft`).
- Bulk: multiple tokens held from the **same contract** in this wallet (e.g. Hefty Presents ×17), or
  the contract is known to mint to very many recipients.
- Name/collection still runs the existing `SPAM_TEXT_PATTERNS`.

### Mandatory false-positive guards (do NOT flag)
These legit holdings in the SAME wallet share "no floor + received free" and MUST stay visible — they
are the test that the heuristic is conservative enough:
- **Uniswap V3 Positions NFT-V1** (`0xC36442b4a4522E871399CD717aBDD847Ab11FE88`) — LP positions, no
  floor, minted free, the wallet holds 3. A naive "no-floor + free + bulk" rule WOULD wrongly flag
  these. Exempt known-legit/utility contracts (Uniswap positions, ENS `NameWrapper`, POAP) via a small
  allowlist, and/or require the name pattern OR a provider hint as a co-signal.
- Verified/known collections present here: Azuki & friends (852 Garden Azuki Passport, Beanz3D, Azuki
  Mizuki, BEANS ONLY CLUB), Zerion DNA, Dirtybird Flight Club, Flipside ShroomDK, ENS — none of these
  may be flagged.

Treat the behavioral signal as adding `spamContract`-equivalent weight only when the combination is
unambiguous; when in doubt, leave it visible.

## Backfill
The behavioral signal needs per-NFT transfer/contract context, so the network-free
`reclassify:nft-spam` can apply only the parts it can compute offline (name + bulk-same-contract from
the DB). Full behavioral re-evaluation happens on the next **resync** (`importNftHoldings`). Update
`reclassify-nft-spam.ts` to apply whatever offline portion is added, and document that a resync is
required for the transfer-based part.

## Manual override (recommended safety net, optional)
Given any heuristic carries residual FP risk, consider a per-NFT manual **flag / unflag** (a
`spamOverride` nullable column that wins over the computed verdict). It's the honest escape hatch in
both directions and complements the toggle. Frontend already has the toggle + badge to build on.

## Validate
- §0 probe output recorded in the PR/commit (set size + membership of the two contracts).
- After the fix (Path A) or heuristic (Path B): **Garbage Bags + Hefty Presents → `spam=true`,
  hidden by default**, `spamCount` rises (≈ 2 → ~6+), the Show-spam toggle reveals them with the badge.
- **Uniswap V3 Positions, ENS, Azuki/Beanz, Zerion DNA stay VISIBLE** (`spam=false`). This is the
  pass/fail line for precision.
- `nft` / `wallet-data` suites green; add cases: provider-DB hit → spam; behavioral combo → spam;
  Uniswap-V3-position-like (no floor + free + bulk, but allowlisted) → NOT spam.

## Interaction with prior work
Reuses the `Nft.spam` field, the hidden-by-default list, `spamCount`, `?includeSpam=true`, and the
shipped frontend Show-spam toggle/badge — **no frontend change needed** (the count just goes up and
more rows carry the badge when revealed).

## Recommendation
Run **§0 first.** Most likely outcome is Path A (the provider signal isn't actually contributing) —
that's the cleanest fix with zero FP risk. Only fall to Path B if Alchemy's list genuinely omits these
contracts, and keep it conservative (the Uniswap-V3-positions guard is the canary).
