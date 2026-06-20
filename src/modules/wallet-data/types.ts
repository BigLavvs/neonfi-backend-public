// Neonfi backend — read-side wallet-data provider contracts (retrofit-47).
//
// A small, provider-agnostic shape that every data source (Moralis, Covalent/GoldRush,
// Alchemy, Ankr) normalizes its response into. The orchestrator (index.ts) tries the
// providers in priority order and the first `ok` summary wins; the initial-sync path
// (sync.ts) reuses the same summary to seed holdings.

export interface WalletToken {
  symbol: string;
  name: string | null;            // token name (for auto-listing non-catalog tokens on sync)
  contractAddress: string | null; // null for native
  balance: number;                // human-readable (formatted) units
  decimals: number | null;
  usdPrice: number | null;        // per-unit USD price from the provider (for valuation/auto-list)
  usdValue: number | null;        // null when a provider can't price it
  isNative: boolean;
}

export interface WalletSummary {
  nativeSymbol: string;
  nativeBalance: number;
  totalUsd: number | null;        // null if NO token had a USD value
  tokenCount: number;             // distinct tokens with balance > 0 (incl. native if > 0)
  tokens: WalletToken[];          // all tokens with balance > 0, sorted by usdValue desc (nulls last)
  provider: string;               // which provider produced this
}

// Per-provider outcome. 'error' = provider failed/unsupported/no-key → try the next one.
export type ProviderStatus = 'ok' | 'empty' | 'error';
export interface ProviderResult {
  status: ProviderStatus;
  summary?: WalletSummary; // present when status === 'ok'
}

// ---------------------------------------------------------------------------
// Transfer history (retrofit-49)
// ---------------------------------------------------------------------------

// One on-chain movement relative to the wallet — native, ERC-20, or NFT. Several of these
// can share a `hash` when a single tx moved more than one asset; the importer keys one
// Transaction row per hash (the existing unique constraint), so multi-asset txs surface
// their first leg (mirrors the webhook path).
export interface WalletTransfer {
  type: 'native' | 'erc20' | 'nft';
  direction: 'in' | 'out'; // relative to the wallet
  hash: string | null;
  from: string | null;
  to: string | null;
  symbol: string | null; // null for nft
  name: string | null;
  contractAddress: string | null;
  amount: number | null; // token qty (nft: 1)
  usdValue: number | null; // historical USD at tx time when the provider gives it
  gasFee: number | null; // native gas paid for the tx (attached to the tx's first leg only)
  timestamp: string; // ISO, the REAL block time
  logoUrl: string | null;
  // nft only:
  nftTokenId: string | null;
  collectionName: string | null;
  description: string | null; // retrofit-51: collectible description (null unless the payload carries it)
}

export interface TransferPage {
  transfers: WalletTransfer[];
  nextCursor: string | null; // null when no more
  totalCount: number | null; // provider's total tx count for the wallet, when available (#8)
}

// A currently-held NFT (predating the transfer window) — mirrors the `Nft` table shape the
// webhook upserts (moralis-handlers.processNftTransfers).
export interface WalletNftHolding {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  description: string | null; // retrofit-51: from normalized_metadata.description; null when absent
  collectionName: string | null;
  logoUrl: string | null;
  tokenStandard: string | null;
  possibleSpam: boolean; // retrofit-73 (H13): provider-flagged airdrop/scam NFT
}

// ---------------------------------------------------------------------------
// Wallet PnL / cost basis (retrofit-79 §1)
// ---------------------------------------------------------------------------

// One token's PnL/cost-basis line as a provider reports it, normalized across providers.
// A connected wallet has no on-chain cost basis from our windowed transfer import, so we
// read it from a provider's turnkey wallet-PnL endpoint (GoldRush → Moralis) and feed the
// EXISTING cost-basis PnL path (the one manual portfolios use). `avgCost` is the weighted-
// average per-unit buy price of the currently-held units (null = genuinely cost-unknown,
// e.g. a transfer-acquired token with no on-chain buy price → stays "—"). `realizedPnlUsd`
// is the cumulative realized PnL for this token (present even for fully-sold tokens, so the
// portfolio's realized total is honest). `unrealizedPnlUsd` is the PROVIDER's own unrealized
// figure — a cross-check only; we recompute unrealized from OUR live price map so it's
// consistent with the rest of the app (GoldRush's current_price is unreliable / often 0).
export interface WalletTokenPnl {
  symbol: string | null;            // contract ticker (for symbol-fallback resolution); null when absent
  contractAddress: string | null;  // on-chain token address (lowercased); null for native
  avgCost: number | null;           // per-unit weighted-avg cost basis; null = cost-unknown
  realizedPnlUsd: number | null;    // cumulative realized PnL (USD)
  unrealizedPnlUsd: number | null;  // provider unrealized (cross-check only — not stored)
}

export interface WalletPnl {
  provider: string;                 // which provider produced this
  tokens: WalletTokenPnl[];         // one entry per token the wallet has traded
}

export interface WalletDataProvider {
  name: string;
  isConfigured(): boolean;            // key present?
  supportsChain(chainSlug: string): boolean;
  getSummary(address: string, chainSlug: string): Promise<ProviderResult>;
  // retrofit-79 (§1): optional turnkey wallet PnL / cost basis. A provider that can't supply
  // it for a chain returns null and the orchestrator falls through (GoldRush first for THIS
  // capability — a per-capability override of the global Moralis-first order — because it
  // returns cost basis + realized + unrealized; Moralis is the realized-only fallback).
  getWalletPnl?(address: string, chainSlug: string): Promise<WalletPnl | null>;
  // retrofit-49: optional real-history capability. A provider that can't supply history for
  // a chain returns null and the orchestrator falls through to the next (Moralis first).
  getTransferHistory?(
    address: string,
    chainSlug: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<TransferPage | null>;
  getNftHoldings?(address: string, chainSlug: string): Promise<WalletNftHolding[] | null>;
  // retrofit-84 (H13): optional cross-provider spam-contract DB. Returns the set of LOWERCASED
  // spam contract addresses for the chain (Alchemy getSpamContracts). The orchestrator unions
  // these across providers and ORs a contract-address hit into each NFT's spam verdict, so the
  // spam signal isn't tied to whichever provider supplied the holdings. null = unsupported/no key.
  getSpamContracts?(chainSlug: string): Promise<Set<string> | null>;
  // retrofit-56: optional connected-portfolio value/count sources (GoldRush/Covalent
  // implements both; other providers skip → null). getTransactionCount is the wallet's
  // REAL on-chain tx total (the fixed count the overview consumes). getValueHistory is the
  // daily portfolio USD value, ASC by date, for backfilling BalanceSnapshot.
  getTransactionCount?(address: string, chainSlug: string): Promise<number | null>;
  getValueHistory?(
    address: string,
    chainSlug: string,
    days: number,
  ): Promise<Array<{ date: string; value: number }> | null>;
}
