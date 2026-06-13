// Token metadata vendor abstraction — interface + shared types.
// Single adapter ships in Stage 9B (Moralis); future adapters implement this
// interface without touching sync logic (Appendix item 2 pattern).

export interface TokenMetadata {
  symbol: string;
  currentPrice: string;   // decimal string preserves precision
  marketCap: string | null;
  rank: number | null;
}

export interface TokenMetadataProvider {
  readonly name: string;  // e.g. 'moralis', 'coinmarketcap'
  fetchMetadata(symbols: string[]): Promise<Map<string, TokenMetadata>>;
}
