# DECISIONS — connected-wallet PnL & value history (pinned; stop relitigating)

The single source of truth for how connected wallets show PnL + history, after the retrofit-77→85
arc. If a change is proposed that contradicts this, re-read this first.

## Guiding principles (these drove every decision)
1. **Lean on the provider; never recompute from incomplete data.** Our connected transfer import is
   WINDOWED (recent only). So we do NOT reconstruct cost basis, PnL, or historical balances from our
   own transactions — we read them from the provider (which indexes the full chain). This is why
   all-time PnL uses provider cost basis (not a DIY net-out) and why retrofit-85 must use provider
   history (not transaction reconstruction).
2. **Never fabricate a number.** If a value is genuinely unknown/approximate, show "—" (unknown) or a
   dashed "estimated" line — never a fabricated or sign-contradicting figure.
3. **Manual portfolios are unaffected** by all of this — they have the user's complete logged
   transactions + opening cost, so their PnL and history are computed from that (retrofit-45/46) and
   are accurate.

## CURRENT STABLE STATE — connected wallet (this is the truth)
- **Current value / balances:** provider summary. DEFINITE.
- **All-time PnL VALUE:** provider cost basis → `unrealized + realized` (e.g. +$1,391 = realized
  +$1,531 − unrealized $139). Shown as the net headline + a **"Realized · Unrealized" breakout**,
  each figure coloured by its own sign. DEFINITE (verified: realized itemizes to real per-token sales).
- **All-time PnL PERCENT:** **"—"** for connected. We can't compute a correct % without lifetime
  invested, and we chose NOT to collect a provider % (retrofit-83 dropped). The breakout $ tells the
  story instead.
- **24h / 7d / 30d:** from OUR daily `balance_snapshot`s (real observations), excluding `approx`
  rows. "—" (and the performance card hidden) until a real baseline exists. Performance windowed
  cards use the strict "ALL selected portfolios must have a baseline" rule.
- **Value-history CHART:** the FULL timeline is shown (retrofit-81), and it's now REAL historical
  value (retrofit-85): GoldRush `portfolio_v2?days=1095` returns a 3-year daily series at HISTORICAL
  balances × HISTORICAL prices → those points are `approx=false` (SOLID). Only the deep tail BEFORE
  the provider's coverage (and chains/wallets a priced provider can't reach) stays the ~today's-price
  estimate → `approx=true` → DASHED. So the dashed segment is now small or gone, not the whole early
  line.
- **Token-detail page (cost-unknown / transfer-acquired token):** labelled **"Price return"** (the
  token's price move), never a $ "PnL" beside "Total invested $0.00" (C7).

## DEFINITE vs ESTIMATED (what to trust)
- DEFINITE/accurate: current value, all-time PnL value (realized + unrealized), 24h, tx count,
  live prices, allocation. All reconcile to the cent (accuracy audit passed).
- ESTIMATED (dashed): now ONLY the deep tail of the value-history line BEFORE the provider's
  historical coverage (retrofit-85 made the covered span real). Often empty when the provider covers
  the whole window.

## Why the dashed line is correct (and now mostly solid)
The value line is REAL where the provider covers it (retrofit-85: GoldRush portfolio_v2 returns a
3-year historically-priced daily series) → SOLID (`approx=false`). The dashed segment remains ONLY for
the deep tail before the provider's coverage / unreachable chains, where we fall back to the
~today's-price Moralis estimate — genuinely approximate, so honestly dashed. Dashed = "this slice is
an estimate," solid = real. Both correct. (retrofit-85 was the gate that flipped this from "mostly
estimated" to "mostly real" — the §0 probe found GoldRush honors a 3-year window in one call.)

## Retrofit status (what shipped, what's dropped, what's held)
- **77** ✅ shipped — `approx` flag; short-term baselines exclude approx (fresh-sync garbage fixed).
- **78** ✅ shipped — N3 reclassify existing connected backfill → approx=true; A1 backfill script writes
  approx + no longer clobbers real rows.
- **79** ✅ shipped — provider cost basis → real all-time VALUE; D1 short-term returns null→"—".
  (§3 "omit estimated chart" was REVERTED by 81; §6 "invested/realized cards" was DROPPED — deposits/
  withdrawals stay "—".)
- **80** ✅ shipped — connected all-time % = "—"; aggregate % guarded (never the impossible −101%).
- **81** ✅ shipped — reverted 79 §3; exposed `approx` per value-history point; restored full timeline.
- **82** ✅ shipped (frontend) — dashed estimated chart segment; realized/unrealized breakout card;
  performance 24h/7d/30d window cards (all-rule); dashboard card grid; C7 labels; 404 fix; null "—"
  rendering. (Frontend tag, not a backend doc.)
- **83** ❌ DROPPED — "collect the wallet PnL % from the provider." Superseded by the breakout + "—".
  Do not build.
- **84** ✅ shipped (f36003b) — NFT spam plumbing: `Nft.spam` verdict; hidden by default + `spamCount`
  + `?includeSpam=true`; `reclassify:nft-spam` backfill. Frontend **"Show spam (N)" toggle now SHIPPED**
  + verified (54↔56, amber "Spam" badge on revealed rows, round-trips). ⚠️ DETECTION UNDER-FLAGS:
  live-verified that even after a full resync only 2 of the obvious spam are caught (both via the NAME
  heuristic). The cross-provider contract signal contributes zero, and only Alchemy implements
  `getSpamContracts` (GoldRush `is_spam` was NEVER wired in, contrary to 84's doc). "Garbage Bags"
  (0xbdead09…) + "Hefty Presents" (0x248e21b0…, ×17) still show. → retrofit-86.
- **86** 📨 AUTHORED (this doc's sibling) — fix the spam signal then a conservative fallback. §0 probe
  GATES it: verify whether Alchemy `getSpamContracts` actually returns these contracts (fix the call if
  it's silently empty — Path A, no FP risk) before adding a behavioral heuristic (Path B). Hard FP
  guard: Uniswap V3 Positions / ENS / Azuki must stay visible. Reuses the shipped toggle — no further
  frontend work.
- **85** ✅ shipped (ec22b0c) — accurate connected historical value. §0 probe RESOLVED: GoldRush
  portfolio_v2?days=1095 returns a real 3-year historically-priced daily series (Zerion empty, Mobula
  key dead, Moralis tail current-priced). Per-point provenance (provider → approx=false, Moralis tail
  → approx=true) + approx-guarded upsert + `rebuild:connected-history` script (ran dev: P18 all 291
  estimates → accurate; P17 929 accurate + 44 deep-tail estimates). No frontend change needed — the
  dashed segment shrinks on its own as points flip to approx=false.

## Status
retrofit-84 + 85 SHIPPED (f36003b, ec22b0c) and live-validated. The 84 frontend Show-spam toggle is
now SHIPPED + verified too. OPEN: retrofit-86 (NFT spam detection) — authored, awaiting CC: run the §0
probe (is Alchemy's spam call working?), then Path A (fix provider signal) or Path B (conservative
behavioral heuristic). Also OPEN: user runs `npm run check` on the frontend (sandbox VM was down this
session so it couldn't be run here).
