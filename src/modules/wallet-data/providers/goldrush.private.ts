export const GOLDRUSH_STREAMING_URL = 'wss://streaming.goldrushdata.com/graphql';
export const UPNL_TIMEOUT_MS = 60000;
export const COV_UPNL_CHAIN: Record<string, string> = {
  eth: 'ETH_MAINNET', base: 'BASE_MAINNET', bnb: 'BSC_MAINNET', polygon: 'POLYGON_MAINNET',
  optimism: 'OPTIMISM_MAINNET', gnosis: 'GNOSIS_MAINNET', solana: 'SOLANA_MAINNET',
};
export const COV_CHAIN: Record<string, string> = {
  eth: 'eth-mainnet', polygon: 'matic-mainnet', bnb: 'bsc-mainnet', arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet', base: 'base-mainnet', avalanche: 'avalanche-mainnet', fantom: 'fantom-mainnet',
  linea: 'linea-mainnet', zksync: 'zksync-mainnet', gnosis: 'gnosis-mainnet', cronos: 'cronos-mainnet',
  mantle: 'mantle-mainnet', solana: 'solana-mainnet',
};
export interface CovalentItem { contract_ticker_symbol?: string | null; contract_name?: string | null; contract_decimals?: number | null; contract_address?: string | null; balance?: string | null; quote?: number | null; quote_rate?: number | null; native_token?: boolean; }
export interface CovalentHolding { timestamp?: string | null; close?: { quote?: number | null } | null; }
export interface CovDecodedParam { name?: string | null; type?: string | null; value?: unknown; }
export interface CovLogEvent { sender_address?: string | null; sender_name?: string | null; sender_contract_ticker_symbol?: string | null; sender_contract_decimals?: number | null; sender_logo_url?: string | null; decoded?: { name?: string | null; params?: CovDecodedParam[] | null } | null; }
export interface CovTxItem { block_signed_at?: string | null; tx_hash?: string | null; from_address?: string | null; to_address?: string | null; value?: string | null; value_quote?: number | null; fees_paid?: string | null; gas_metadata?: { contract_decimals?: number | null; contract_ticker_symbol?: string | null } | null; log_events?: CovLogEvent[] | null; }
export interface CovTxResponse { data?: { links?: { prev?: string | null; next?: string | null } | null; items?: CovTxItem[] | null } | null; }
export interface CovNftExternalData { name?: string | null; description?: string | null; image?: string | null; image_512?: string | null; image_preview?: string | null; }
export interface CovNftData { token_id?: string | null; token_balance?: string | null; external_data?: CovNftExternalData | null; }
export interface CovNftItem { contract_name?: string | null; contract_address?: string | null; supports_erc?: string[] | null; is_spam?: boolean; nft_data?: CovNftData[] | null; }
export interface UpnlWalletItem { token_address?: string | null; cost_basis?: number | null; pnl_realized_usd?: number | null; pnl_unrealized_usd?: number | null; }
export function num(v: number | string | null | undefined): number | null { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
export function humanBalance(raw: string | null | undefined, decimals: number | null): number { if (raw == null) return 0; const n = Number(raw); if (!Number.isFinite(n)) return 0; return decimals && decimals > 0 ? n / 10 ** decimals : n; }
