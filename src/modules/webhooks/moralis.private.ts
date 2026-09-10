import { z } from 'zod';
import jsSha3 from 'js-sha3';
const { keccak256 } = jsSha3;
export const REDIS_TTL_30_DAYS = 2592000;

// ---------------------------------------------------------------------------
// Moralis Streams payload types
// ---------------------------------------------------------------------------

interface MoralisBlock {
  timestamp?: string;
  number?: string;
  hash?: string;
}

export interface MoralisNativeTx {
  hash?: string;
  from?: string;
  to?: string;
  fromAddress?: string;
  toAddress?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
}

export interface MoralisErc20Transfer {
  transactionHash?: string;
  from?: string;
  to?: string;
  value?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: string;
  contract?: string;
}

export interface MoralisNftTransfer {
  transactionHash?: string;
  from?: string;
  to?: string;
  tokenAddress?: string;
  tokenId?: string;
  amount?: string;
  // Marketplace fields — present when Moralis includes them, absent otherwise
  tokenName?: string;
  collectionName?: string;
  logoUrl?: string;
  tokenStandard?: string;
  floorPrice?: string;
  floorPriceUsd?: string;
  lastSale?: string;
  lastSaleNote?: string;
  rarity?: string;
  traits?: unknown;
}

export interface MoralisPayload {
  txs?: MoralisNativeTx[];
  erc20Transfers?: MoralisErc20Transfer[];
  nftTransfers?: MoralisNftTransfer[];
  chainId?: string;
  streamId?: string;
  tag?: string;
  confirmed?: boolean;
  block?: MoralisBlock;
}

// Structural validation of the (signature-verified) payload (audit SEC #22). This guards the
// SHAPE only — that the transfer fields are arrays of objects, confirmed is a boolean, etc. —
// so a malformed structure can't make `for...of` iterate a string or coerce surprising types.
// It deliberately does NOT enforce numeric format on per-transfer value/decimals strings:
// rejecting the whole payload for one bad transfer would 400 a batch that mostly ingests fine,
// so per-transfer numeric validity is handled downstream as a deterministic skip (safeBigInt).
// `.passthrough()` keeps any extra Moralis fields we don't model. A signature-valid body that
// still fails this is a provider/transport defect → 400 (deterministic, so Moralis won't loop).
const transferObject = z.object({}).passthrough();
export const MoralisPayloadSchema = z
  .object({
    txs: z.array(transferObject).optional(),
    erc20Transfers: z.array(transferObject).optional(),
    nftTransfers: z.array(transferObject).optional(),
    chainId: z.string().optional(),
    streamId: z.string().optional(),
    tag: z.string().optional(),
    confirmed: z.boolean().optional(),
    block: z.object({}).passthrough().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Native token symbol per Moralis chain ID (for native transfer handling)
// ---------------------------------------------------------------------------

export const CHAIN_NATIVE_SYMBOL: Record<string, string> = {
  '0x1': 'ETH',      // Ethereum
  '0x89': 'MATIC',   // Polygon
  '0x38': 'BNB',     // BNB Chain
  '0xa4b1': 'ETH',   // Arbitrum
  '0xa': 'ETH',      // Optimism
  '0x2105': 'ETH',   // Base
  '0xa86a': 'AVAX',  // Avalanche
  'solana': 'SOL',   // Solana
  '0xfa': 'FTM',     // Fantom
  '0xe708': 'ETH',   // Linea
  '0x144': 'ETH',    // zkSync Era
  '0x44d': 'ETH',    // Polygon zkEVM (gas token is ETH, not MATIC)
  '0x19': 'CRO',     // Cronos
  '0x64': 'XDAI',    // Gnosis
  '0x1388': 'MNT',   // Mantle
};

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

// Max token decimals we'll honor. Bounds 10n ** BigInt(decimals) so a hostile/garbled
// `tokenDecimals` (e.g. "1000000000") can't allocate a gigantic BigInt → CPU/memory DoS
// (audit SEC #22). 36 clears every real ERC-20 (the largest in practice is 18) with margin.
const MAX_TOKEN_DECIMALS = 36;

// Parse an untrusted smallest-unit amount string to a non-negative BigInt, or null if it
// isn't a plain non-negative integer (audit SEC #8/#22). Moralis sends decimal integer
// strings; anything else (empty after the zero-guard, signs, hex, decimals, letters) is
// malformed on-chain data we can never ingest, so the caller treats null as a DETERMINISTIC
// skip (ack + dedupe) rather than letting BigInt() throw and force an infinite retry loop.
function safeBigInt(str: string): bigint | null {
  if (!/^[0-9]+$/.test(str)) return null;
  try {
    return BigInt(str);
  } catch {
    return null;
  }
}

// Converts wei (10^18 units) to a decimal string (e.g., '1000000000000000000' → '1').
// Returns null on a malformed value string (deterministic skip — see safeBigInt).
export function convertWeiToEther(weiStr: string): string | null {
  if (!weiStr || weiStr === '0') return '0';
  const wei = safeBigInt(weiStr);
  if (wei === null) return null;
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const remainder = wei % divisor;
  if (remainder === 0n) return whole.toString();
  const decStr = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}.${decStr}`;
}

// Converts token smallest-unit value to decimal string using tokenDecimals.
// Returns null on a malformed value or out-of-range decimals (deterministic skip).
export function convertTokenAmount(valueStr: string, decimalsStr: string): string | null {
  if (!valueStr || valueStr === '0') return '0';
  const decimals = parseInt(decimalsStr || '18', 10);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) return null;
  const raw = safeBigInt(valueStr);
  if (raw === null) return null;
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const decStr = remainder.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${decStr}`;
}

// ---------------------------------------------------------------------------
// Event ID extraction — idempotency key derivation
// ---------------------------------------------------------------------------

export function extractEventId(rawBody: string): string {
  // Per-DELIVERY idempotency: keccak256 of the exact raw body. (audit SEC #17)
  // streamId/chainId/tag are immutable for a stream's lifetime, so keying on
  // `${streamId}_${chainId}_${tag}` returned the SAME string for every delivery and pinned
  // the dedupe key for 30 days — every webhook after the first was silently dropped. The raw
  // body differs per delivery (distinct block/tx/log data + the confirmed flag), so the hash
  // is unique per delivery while a genuine replay of the identical body still dedupes.
  return `kc:${keccak256(rawBody)}`;
}

// ---------------------------------------------------------------------------
// Portfolio lookup — find connected portfolio by walletAddress + chainId
// ---------------------------------------------------------------------------
