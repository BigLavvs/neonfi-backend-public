// Neonfi backend — multi-signal NFT spam classifier (retrofit-84, H13).
//
// Moralis' `possible_spam` alone UNDER-flags airdrop spam (the demo wallet still shows
// "Garbage Bags" / "Hefty Presents" as holdings). The fix combines signals, consistent with the
// multi-provider orchestrator:
//   1. Provider flags (PRIMARY) — Moralis possible_spam, Alchemy spam-contract DB
//      (getSpamContracts), GoldRush is_spam. These are layered in by the sync via
//      fetchSpamContracts(); a hit on ANY makes the NFT spam.
//   2. Name/collection heuristic (SECONDARY) — catches promotional airdrop spam the providers miss
//      ("claim 2000 USDC at site.xyz"). Deliberately conservative (high precision) so legit
//      collections are never flagged; the provider flag stays the primary signal.
// `spam` is the OR of all of these. We never auto-delete — spam NFTs are persisted + hidden, and a
// "Show spam" toggle can surface them.

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

// True when the NFT's name/collection text trips a conservative airdrop-spam pattern. Used as the
// SECONDARY signal (and as the only network-free signal the reclassify backfill can apply to
// existing rows).
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
  // Cross-provider spam-contract DB hit (Alchemy getSpamContracts / GoldRush is_spam) for this
  // NFT's contract — layered in by the orchestrator regardless of which provider supplied holdings.
  spamContract?: boolean;
  name?: string | null;
  collectionName?: string | null;
}

// The combined verdict: any provider flag (primary) OR the conservative heuristic (secondary).
export function classifyNftSpam(s: NftSpamSignals): boolean {
  if (s.possibleSpam === true) return true; // provider holdings flag (primary)
  if (s.spamContract === true) return true; // cross-provider spam-contract DB (primary)
  return isHeuristicNftSpam(s.name, s.collectionName); // heuristic (secondary)
}
