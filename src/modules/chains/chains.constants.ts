export interface ChainSeed {
  name: string;
  slug: string;
  moralisId: string;
  logoUrl: string | null;
}

export const CHAINS: ChainSeed[] = [
  { name: 'Ethereum',      slug: 'eth',           moralisId: '0x1',    logoUrl: null },
  { name: 'Polygon',       slug: 'polygon',       moralisId: '0x89',   logoUrl: null },
  { name: 'BNB Chain',     slug: 'bnb',           moralisId: '0x38',   logoUrl: null },
  { name: 'Arbitrum',      slug: 'arbitrum',      moralisId: '0xa4b1', logoUrl: null },
  { name: 'Optimism',      slug: 'optimism',      moralisId: '0xa',    logoUrl: null },
  { name: 'Base',          slug: 'base',          moralisId: '0x2105', logoUrl: null },
  { name: 'Avalanche',     slug: 'avalanche',     moralisId: '0xa86a', logoUrl: null },
  { name: 'Solana',        slug: 'solana',        moralisId: 'solana', logoUrl: null },
  { name: 'Fantom',        slug: 'fantom',        moralisId: '0xfa',   logoUrl: null },
  { name: 'Linea',         slug: 'linea',         moralisId: '0xe708', logoUrl: null },
  { name: 'zkSync Era',    slug: 'zksync',        moralisId: '0x144',  logoUrl: null },
  { name: 'Polygon zkEVM', slug: 'polygon-zkevm', moralisId: '0x44d',  logoUrl: null },
  { name: 'Cronos',        slug: 'cronos',        moralisId: '0x19',   logoUrl: null },
  { name: 'Gnosis',        slug: 'gnosis',        moralisId: '0x64',   logoUrl: null },
  { name: 'Mantle',        slug: 'mantle',        moralisId: '0x1388', logoUrl: null },
];

export const FREE_TIER_CHAIN_SLUGS: readonly string[] = ['eth', 'polygon', 'bnb'];
