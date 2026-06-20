# retrofit-86 — §0 probe verdict + chosen path

Probe: `npm run probe:nft-spam` (`src/scripts/probe-nft-spam.ts`, read-only, throwaway).

## §0 probe output (eth mainnet, demo wallet P17/P18)
```
probe_fetchSpamContracts: size 0
probe_alchemy_method:     configured=true, setSize=null
probe_alchemy_raw:        httpStatus 403, ok=false,
                          body="The following method: nft can only be used with a growth or higher
                                plan. Please upgrade your account..."
probe_membership Garbage Bags  (0xbdead0…b6e7): inUnioned=false
probe_membership Hefty Presents(0x248e21…d1b5): inUnioned=false
probe_goldrush_nft P17/P18: collections=35, spamFlagged=6   ← GoldRush DOES classify spam, callable
probe_goldrush_missed Garbage Bags:   is_spam=false          ← but misses BOTH
probe_goldrush_missed Hefty Presents: is_spam=false
probe_db_contract: floorPrice/lastSale NULL for EVERY contract (Moralis getNftHoldings never sets them)
probe_acq: 0 nft tx rows for Garbage Bags / Hefty / Uniswap / Beanz3D (predate the ~100-tx window)
held counts: Hefty Presents=17, Garbage Bags=2; legit max=4 (Azuki Mizuki), Uniswap=3, Beanz3D=3
```

## Interpretation
- **Alchemy `getSpamContracts` endpoint path is CORRECT** (403, not 404). It is **plan-gated** —
  the NFT API requires a "growth or higher" Alchemy plan; our key is free-tier. So the *entire*
  cross-provider spam signal (defect #1: only Alchemy implemented it) contributes **zero**. This is a
  billing limitation, not a fixable endpoint/auth/parse bug. (Note: Alchemy `getNftHoldings` is dead
  on our plan for the same reason — Moralis carries NFT holdings.)
- **GoldRush** is callable on our plan and *does* classify spam (6/35), but `is_spam=false` for both
  missed contracts → providers we can call **genuinely don't cover** Garbage Bags / Hefty Presents.
- The spec's behavioral candidates "no floor" and "free-acquisition via transfer rows" are **not
  computable** here: floor/lastSale are universally null, and these NFTs have no imported transfer
  rows (they predate the transfer window — holdings come from `importNftHoldings`, a snapshot).
- The only signals actually available: name heuristic (exists), provider flags, **per-contract held
  count**.

## Chosen path — HYBRID (Path A defect-fix + conservative Path B)
1. **Path A (defect #1): wire GoldRush per-wallet `is_spam`.** GoldRush spam is per-WALLET
   (`balances_nft`), not chain-global, so add a new `getWalletSpamContracts(address, chainSlug)`
   capability + orchestrator `fetchWalletSpamContracts`; `importNftHoldings` unions it with the
   chain-global `fetchSpamContracts` (Alchemy, cached, kept for when the plan is upgraded). Adds 6
   real flags at zero FP. Both sets cached per chain/wallet so resync + webhook don't refetch.
2. **Path A (defect #3): webhook NFT path applies the full combined verdict** (was name-only), using
   the same cached spam-contract set + held-count, matching `importNftHoldings`.
3. **Path B (behavioral, conservative):** in `classifyNftSpam` —
   - **bulk:** `heldCount >= NFT_BULK_SPAM_MIN` (default 10; legit max observed = 4) AND not
     allowlisted → spam. Catches Hefty Presents (17) behaviorally.
   - **curated known-spam blocklist** (`KNOWN_SPAM_CONTRACTS`): supplements provider DBs for verified
     mass-airdrop contracts they miss → catches Garbage Bags (held 2, otherwise uncatchable).
     Zero-FP (curated/verified), extensible.
   - **allowlist** (`LEGIT_CONTRACTS`: Uniswap V3 Positions, ENS NameWrapper + BaseRegistrar, POAP):
     hard-exempt — the canary guard. Uniswap (held 3) / ENS / Azuki / Zerion DNA stay visible.
4. **Manual override (`spamOverride` nullable Boolean):** applied at READ time
   (`effectiveNftSpam = spamOverride ?? spam`) so a resync never clobbers it; `PATCH
   /portfolios/:id/nfts/:id` flags/unflags. The honest two-way escape hatch for the bulk signal's
   residual FP risk.
5. **Backfill:** `reclassify:nft-spam` now applies the offline portion (name + bulk-from-DB +
   blocklist + allowlist); GoldRush per-wallet DB still applies on the next resync.

Result: Garbage Bags + Hefty Presents → spam; Uniswap/ENS/Azuki/Beanz/Zerion DNA stay visible.
