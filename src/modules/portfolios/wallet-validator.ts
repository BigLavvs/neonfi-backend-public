// EVM: 0x + 40 hex chars (case-insensitive). Normalize to lowercase on match.
// Solana: base58 alphabet (excludes 0/O/I/l), 32–44 chars. Case-sensitive; no normalization.
const EVM_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateWalletAddress(
  address: string,
  chain: { slug: string },
): { valid: boolean; normalized?: string } {
  if (chain.slug === 'solana') {
    return SOLANA_REGEX.test(address)
      ? { valid: true, normalized: address }
      : { valid: false };
  }
  return EVM_REGEX.test(address)
    ? { valid: true, normalized: address.toLowerCase() }
    : { valid: false };
}
