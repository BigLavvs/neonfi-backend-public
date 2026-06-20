// Neonfi backend — multi-signal NFT spam classifier (retrofit-84, extended retrofit-86 H13.1).
//
// Moralis' `possible_spam` alone UNDER-flags airdrop spam (the demo wallet still shows
// "Garbage Bags" / "Hefty Presents" as holdings). retrofit-86's §0 probe established WHY the
// cross-provider signal contributed zero and what we can actually compute (see
// _claude/DECISIONS-retrofit-86.md):
//   - Alchemy `getSpamContracts` is PLAN-GATED (HTTP 403, "nft method needs growth+ plan") — the
//     endpoint is correct but uncallable on our tier, so the chain-global signal is empty today.
//   - GoldRush DOES classify spam and IS callable, but per-WALLET (balances_nft.is_spam), and it
//     misses Garbage Bags / Hefty Presents.
//   - floorPrice/lastSale are never populated by getNftHoldings, and these NFTs have no imported
//     transfer rows (they predate the window) — so the spec's "no-floor" / "free-acquisition"
//     candidates are NOT computable here. The signals we actually have: provider flags, name text,
//     and per-contract HELD COUNT.
//
// The combined `spam` verdict is the OR of (precision-ordered):
//   1. Allowlist (FP GUARD, wins first) — known-legit/utility contracts (Uniswap V3 Positions,
//      ENS, POAP) are NEVER spam. This is the canary that keeps LP positions etc. visible.
//   2. Curated known-spam blocklist (PRIMARY) — verified mass-airdrop contracts the provider DBs
//      miss. Supplements (does not replace) the provider signal; zero-FP because it's hand-verified.
//   3. Provider flags (PRIMARY) — Moralis possible_spam, Alchemy spam-contract DB, GoldRush
//      per-wallet is_spam — layered in by the sync via fetchSpamContracts/fetchWalletSpamContracts.
//   4. Bulk airdrop (SECONDARY, behavioral) — heldCount ≥ NFT_BULK_SPAM_MIN from one contract.
//   5. Name/collection heuristic (SECONDARY) — promotional airdrop text the providers miss.
// We never auto-delete — spam NFTs are persisted + hidden, and a "Show spam" toggle surfaces them.
// A per-NFT manual override (spamOverride) wins over this computed verdict at read time
// (effectiveNftSpam) — the honest two-way escape hatch for the bulk signal's residual FP risk.

import { config } from '../../lib/config.js';

// Conservative, high-precision spam name/collection patterns. Each is a classic
// promotional-airdrop tell that essentially never appears in a legit NFT/collection name. We
// intentionally DON'T match on bare emoji or vague words (false-positive risk) — provider spam DBs
// cover the rest.
const SPAM_TEXT_PATTERNS: RegExp[] = [
  /https?:\/\//i, // an embedded URL
  /\bwww\.[a-z0-9-]/i, // bare www. domain
  // a domain with a TLD commonly used by airdrop-spam landing pages
  /\b[a-z0-9-]{2,}\.(?:com|io|xyz|net|org|app|fi|vip|club|life|store|cc|top|win|gift|finance|site|online|claim|link|info|pro|gg)\b/i,
  /\bclaim(?:ing|able|ed|s)?\b/i, // "claim", "claimable", "claim rewards"
  /\brewards?\b/i,
  /\bvouchers?\b/i,
  /\bairdrops?\b/i,
  /\bgiveaways?\b/i,
  /\bredeem\b/i,
  /\bvisit\b/i, // "Visit site.xyz to claim"
  /\beligible\b/i,
  /\$\s?\d/, // "$1000", "$ 50"
  /\b\d[\d,.]*\s?(?:usd|usdt|usdc|eth|bnb|matic|dai|busd)\b/i, // "2000 USDC", "1.5 ETH"
];

// retrofit-86 (H13.1): FP GUARD — known-legit/utility contracts that share the "no floor + received
// free + bulk" shape of airdrop spam and so MUST be exempt from the behavioral + heuristic signals
// (the canary from the spec). Lowercased eth-mainnet addresses. These are NEVER flagged spam.
export const LEGIT_CONTRACTS = new Set<string>([
  '0xc36442b4a4522e871399cd717abdd847ab11fe88', // Uniswap V3 Positions NFT-V1 (LP positions)
  '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401', // ENS: NameWrapper
  '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', // ENS: BaseRegistrarImplementation (.eth names)
  '0x22c1f6050e56d2876009903609a2cc3fef83b415', // POAP
]);

// retrofit-86 (H13.1): a SMALL curated blocklist of verified mass-airdrop spam contracts the
// provider DBs miss on our plan (§0 probe: neither Moralis possible_spam, GoldRush is_spam, nor
// the plan-gated Alchemy list flags these). This supplements provider DBs the same way they ARE
// curated lists; zero-FP because each is hand-verified, and extensible as new ones surface.
// Lowercased eth-mainnet addresses.
export const KNOWN_SPAM_CONTRACTS = new Set<string>([
  '0xbdead093d03758772fc2f0dd6d836f0df6bdb6e7', // "Garbage Bags" (held ×2, no floor, no name tell)
  '0x248e21b0aa161efe3045e3d067d972cd6a01d1b5', // "Hefty Presents" (held ×17 mass airdrop)
]);

const norm = (a?: string | null): string => (a ?? '').toLowerCase();

export function isLegitContract(contractAddress?: string | null): boolean {
  return LEGIT_CONTRACTS.has(norm(contractAddress));
}

export function isKnownSpamContract(contractAddress?: string | null): boolean {
  return KNOWN_SPAM_CONTRACTS.has(norm(contractAddress));
}

// True when the NFT's name/collection text trips a conservative airdrop-spam pattern. Used as a
// SECONDARY signal (and one of the network-free signals the reclassify backfill can apply offline).
export function isHeuristicNftSpam(
  name?: string | null,
  collectionName?: string | null,
): boolean {
  const text = `${name ?? ''} ${collectionName ?? ''}`.trim();
  if (!text) return false;
  return SPAM_TEXT_PATTERNS.some((re) => re.test(text));
}

export interface NftSpamSignals {
  // Provider holdings flag (Moralis possible_spam, Alchemy contract.isSpam, …) on the source row.
  possibleSpam?: boolean;
  // Cross-provider spam-contract DB hit (Alchemy getSpamContracts ∪ GoldRush per-wallet is_spam) for
  // this NFT's contract — layered in by the orchestrator regardless of which provider supplied it.
  spamContract?: boolean;
  name?: string | null;
  collectionName?: string | null;
  // retrofit-86 (H13.1): the NFT's contract (for the allow/block lists) and how many tokens from
  // that contract this wallet holds (the bulk-airdrop signal). Both optional — when absent the
  // behavioral signal simply doesn't contribute (degrades to provider-flag-OR-heuristic).
  contractAddress?: string | null;
  heldCount?: number;
}

// The combined verdict. Allowlist wins first (FP guard); then the precision-ordered OR.
export function classifyNftSpam(s: NftSpamSignals): boolean {
  if (isLegitContract(s.contractAddress)) return false; // FP guard (canary) — always visible
  if (isKnownSpamContract(s.contractAddress)) return true; // curated blocklist (primary)
  if (s.possibleSpam === true) return true; // provider holdings flag (primary)
  if (s.spamContract === true) return true; // cross-provider spam-contract DB (primary)
  if ((s.heldCount ?? 0) >= config.NFT_BULK_SPAM_MIN) return true; // bulk airdrop (secondary)
  return isHeuristicNftSpam(s.name, s.collectionName); // name heuristic (secondary)
}

// retrofit-86 (H13.1): the EFFECTIVE verdict shown/filtered at read time. A per-NFT manual override
// (spamOverride: true = force-spam, false = force-visible, null = no override) wins over the computed
// `spam`, so a resync recomputing `spam` never clobbers a user's decision.
export function effectiveNftSpam(row: { spam: boolean; spamOverride?: boolean | null }): boolean {
  return row.spamOverride ?? row.spam;
}
