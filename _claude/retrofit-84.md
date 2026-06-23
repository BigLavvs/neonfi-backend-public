# retrofit-84 — NFT spam filtering (H13)

The NFT tab shows **56 NFTs including obvious airdrop spam** ("Garbage Bags", "Hefty Presents").
We currently rely solely on Moralis `possible_spam`, which under-flags these — and existing rows
default `possible_spam=false` until a resync. A production wallet tracker must not present spam as
holdings. Fix with a multi-signal classifier (consistent with the multi-provider orchestrator) + a
user toggle.

## Signals (combine; any → spam)
1. **Provider flags (multi-provider):**
   - Moralis `possible_spam` (already collected — keep).
   - **Alchemy spam contracts:** Alchemy exposes a spam-contract classification
     (`getSpamContracts` / `isSpamContract` on the NFT API). Add an Alchemy adapter call in the NFT
     path and OR its result in. (GoldRush also has an `is_spam` flag on NFT data — use if present.)
2. **Heuristic (catches what providers miss):**
   - no floor price / zero floor AND not a verified/known collection, AND
   - acquired via an inbound transfer with no matching outbound payment (airdrop pattern), and/or
   - name/collection matches obvious spam patterns (URLs, "claim", "reward", "voucher", "gift",
     "$", emoji-spam) — keep the list conservative to avoid false positives on legit NFTs.
   Treat the heuristic as a SECONDARY signal (provider flag is primary) to limit false positives.

## Storage + behaviour
- Add `spam Boolean @default(false)` to the `Nft` model (mirrors retrofit-77's `approx` pattern);
  set it during the NFT sync from the combined signals.
- **Filter spam from the default NFT list + the NFT count** (the wallet tab "X NFTs" and the grid).
- Add a **"Show spam (N)"** toggle (frontend) so nothing is permanently hidden — the user can audit.
- **Backfill existing rows:** a one-off reclassify (like retrofit-78 N3) OR re-flag on the next
  resync; existing `spam=false` rows are re-evaluated against the new signals.
- Never auto-delete — only hide/flag (deleting is destructive + they'd re-sync).

## Validate
- The demo wallet's "Garbage Bags" / "Hefty Presents" are flagged `spam=true` and hidden by default;
  the NFT count drops to the legit set.
- A legit NFT with a real floor / known collection is NOT flagged.
- "Show spam" reveals the hidden ones; toggling back hides them.
- nft / wallet-data suites green; add: provider-flag OR heuristic → spam; legit NFT stays visible.

## Note
Multi-provider: the spam signal should come through the wallet-data orchestrator like other NFT data
(Moralis primary, Alchemy/GoldRush spam flags layered) — not a single-vendor dependency.
