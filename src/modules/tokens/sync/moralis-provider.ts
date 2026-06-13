// Moralis token metadata adapter.
//
// STOP GATE 2 — PLACEHOLDER: Moralis's API is address-centric (requires EVM
// contract address + chain for price lookup). Symbol-based batch price queries
// aren't available as a single endpoint. Until Idowu confirms the approach,
// this provider logs a warning and returns an empty Map (skipping all symbols).
//
// Options to discuss with Idowu:
//   A) Two-step via Moralis: GET /erc20/metadata?symbols[]=... → get addresses
//      then POST /erc20/prices with the address list.
//   B) Add a contractAddress column to the Token table so we can query by address.
//   C) Use a different price source that is symbol-native (e.g. CoinGecko free tier).
//
// The architecture (interface + adapter) is correct either way — only this file
// needs updating once the endpoint is confirmed.

import type { TokenMetadataProvider, TokenMetadata } from './provider.js';

export class MoralisTokenMetadataProvider implements TokenMetadataProvider {
  readonly name = 'moralis';

  constructor(private readonly apiKey: string) {}

  async fetchMetadata(symbols: string[]): Promise<Map<string, TokenMetadata>> {
    if (!this.apiKey) {
      console.warn('[moralis-provider] MORALIS_API_KEY is not set — skipping fetch');
      return new Map();
    }

    // Placeholder — see file-level comment above.
    console.warn(
      '[moralis-provider] fetchMetadata is not yet implemented. ' +
        'Moralis API requires EVM contract addresses, not symbols. ' +
        `Symbols requested (${symbols.length}): ${symbols.slice(0, 5).join(', ')}` +
        (symbols.length > 5 ? ` … +${symbols.length - 5} more` : ''),
    );
    return new Map();
  }
}
