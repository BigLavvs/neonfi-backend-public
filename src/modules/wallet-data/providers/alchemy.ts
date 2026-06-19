// Neonfi backend — Alchemy read-side wallet provider (retrofit-47, fallback 2).
//
// Uses the Alchemy Portfolio Data API `assets/tokens/by-address`, which returns balances
// + metadata (+ USD price on supported tiers) in one call. tokenBalance is a hex string
// scaled by decimals; tokenAddress null = the chain's native gas token. USD pricing is
// OPTIONAL — when a token has no price the value stays null (summary still shows balances
// + count). The JSON-RPC fallback in the spec is not wired (Data API is sufficient here).
// Network/HTTP/parse failure → { status: 'error' }.

import type {
  ProviderResult,
  TransferPage,
  WalletDataProvider,
  WalletNftHolding,
  WalletToken,
  WalletTransfer,
} from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Alchemy network identifier.
const ALCHEMY_NETWORK: Record<string, string> = {
  eth: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  base: 'base-mainnet',
  avalanche: 'avax-mainnet',
  bnb: 'bnb-mainnet',
  fantom: 'fantom-mainnet',
  linea: 'linea-mainnet',
  gnosis: 'gnosis-mainnet',
  solana: 'solana-mainnet',
};

interface AlchemyToken {
  network?: string;
  tokenAddress?: string | null; // null for native
  tokenBalance?: string | null; // hex
  tokenMetadata?: { symbol?: string | null; decimals?: number | null; name?: string | null } | null;
  tokenPrices?: Array<{ currency?: string; value?: string | number | null }> | null;
}

export class AlchemyWalletProvider implements WalletDataProvider {
  readonly name = 'alchemy';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return chainSlug in ALCHEMY_NETWORK;
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    const network = ALCHEMY_NETWORK[chainSlug];
    if (!network) return { status: 'error' };
    try {
      const url = `https://api.g.alchemy.com/data/v1/${this.apiKey!}/assets/tokens/by-address`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ addresses: [{ address, networks: [network] }] }),
      });
      if (!res.ok) return { status: 'error' };
      const json = (await res.json()) as { data?: { tokens?: AlchemyToken[] } };
      const items = Array.isArray(json.data?.tokens) ? json.data!.tokens! : [];

      const kept: WalletToken[] = [];
      for (const it of items) {
        const isNative = it.tokenAddress == null;
        const meta = it.tokenMetadata ?? {};
        const decimals = meta.decimals ?? (isNative ? 18 : null);
        const balance = hexToHuman(it.tokenBalance, decimals);
        if (!Number.isFinite(balance) || balance <= 0) continue;
        const symbol = (meta.symbol ?? (isNative ? NATIVE_SYMBOLS[chainSlug] : '') ?? '').toUpperCase();
        if (!symbol) continue;
        const usdPrice = extractUsdPrice(it.tokenPrices);
        const usdValue = usdPrice != null ? usdPrice * balance : null;
        if (usdValue == null && !isNative) continue; // unpriced non-native dust
        kept.push({
          symbol,
          name: meta.name ?? null,
          contractAddress: isNative ? null : (it.tokenAddress ?? null),
          balance,
          decimals,
          usdPrice,
          usdValue,
          isNative,
        });
      }

      if (kept.length === 0) return { status: 'empty' };
      return { status: 'ok', summary: buildSummary(this.name, kept, NATIVE_SYMBOLS[chainSlug] ?? '') };
    } catch (e) {
      console.error('[wallet-data] alchemy getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }

  // retrofit-63: real transfer history (fallback behind Moralis). alchemy_getAssetTransfers
  // returns ALREADY-NORMALIZED transfers (human `value`, category, hex tokenIds) but only ONE
  // direction per call, so we query fromAddress + toAddress and merge. It carries no per-transfer
  // gas or USD (both stay null). Pagination is per-direction (`pageKey`), so the opaque cursor
  // packs BOTH keys; a continuation only re-queries a direction that still has a key. EVM only
  // (Solana → null). Non-2xx / RPC error / parse → null so the orchestrator falls through.
  async getTransferHistory(
    address: string,
    chainSlug: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<TransferPage | null> {
    if (chainSlug === 'solana') return null;
    const network = ALCHEMY_NETWORK[chainSlug];
    if (!network) return null;
    const wallet = address.toLowerCase();
    const limit = opts.limit ?? 100;
    const first = !opts.cursor;
    let cur: { f: string | null; t: string | null } = { f: null, t: null };
    if (opts.cursor) {
      try {
        cur = JSON.parse(opts.cursor) as { f: string | null; t: string | null };
      } catch {
        return null;
      }
    }
    try {
      const rpc = `https://${network}.g.alchemy.com/v2/${this.apiKey!}`;
      const query = async (
        dir: 'from' | 'to',
        pageKey: string | null,
      ): Promise<AlchemyAssetTransfersResult | null> => {
        const p: Record<string, unknown> = {
          fromBlock: '0x0',
          toBlock: 'latest',
          category: ['external', 'erc20', 'erc721', 'erc1155'],
          withMetadata: true,
          // Drop 0-value native/erc20 legs (empty contract calls, approvals) — they carry no
          // feed meaning and would import as 0-amount buys/sells. NFTs have a NULL (not 0) value,
          // so they're untouched. Matches GoldRush, which skips value==0 native legs.
          excludeZeroValue: true,
          order: 'desc',
          maxCount: '0x' + limit.toString(16),
        };
        if (dir === 'from') p.fromAddress = address;
        else p.toAddress = address;
        if (pageKey) p.pageKey = pageKey;
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'alchemy_getAssetTransfers',
            params: [p],
          }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { result?: AlchemyAssetTransfersResult; error?: unknown };
        if (json.error || !json.result) return null;
        return json.result;
      };

      const [rf, rt] = await Promise.all([
        first || cur.f != null ? query('from', cur.f) : Promise.resolve(null),
        first || cur.t != null ? query('to', cur.t) : Promise.resolve(null),
      ]);
      if (rf === null && rt === null) return null; // both errored (not merely exhausted)

      // Merge both directions, de-dupe by uniqueId (a self-transfer surfaces in both).
      const seen = new Set<string>();
      const transfers: WalletTransfer[] = [];
      for (const t of [...(rf?.transfers ?? []), ...(rt?.transfers ?? [])]) {
        const key = t.uniqueId ?? `${t.hash}:${t.category}:${t.tokenId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mapped = mapAlchemyTransfer(t, wallet, chainSlug);
        if (mapped) transfers.push(mapped);
      }
      const nf = rf?.pageKey ?? null;
      const nt = rt?.pageKey ?? null;
      const nextCursor = nf || nt ? JSON.stringify({ f: nf, t: nt }) : null;
      return { transfers, nextCursor, totalCount: null };
    } catch (e) {
      console.error('[wallet-data] alchemy getTransferHistory failed', (e as Error).message);
      return null;
    }
  }

  // retrofit-63: current NFT holdings (fallback behind Moralis). getNFTsForOwner returns DECIMAL
  // tokenIds (matches Moralis format=decimal + the decimal ids the transfer import writes, so the
  // Nft @@unique doesn't dupe). One page of up to 100 (free-tier excludeFilters=SPAM needs a paid
  // plan, so spam isn't filtered here — same stance as Moralis, which keeps all wallet NFTs). EVM
  // only. Non-2xx / parse → null.
  async getNftHoldings(address: string, chainSlug: string): Promise<WalletNftHolding[] | null> {
    if (chainSlug === 'solana') return null;
    const network = ALCHEMY_NETWORK[chainSlug];
    if (!network) return null;
    try {
      const url =
        `https://${network}.g.alchemy.com/nft/v3/${this.apiKey!}/getNFTsForOwner` +
        `?owner=${address}&withMetadata=true&pageSize=100`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as { ownedNfts?: AlchemyOwnedNft[] };
      const items = Array.isArray(json.ownedNfts) ? json.ownedNfts : [];
      const holdings: WalletNftHolding[] = [];
      for (const it of items) {
        const contract = (it.contract?.address ?? '').toLowerCase();
        const tokenId = it.tokenId ?? '';
        if (!contract || !tokenId) continue;
        const img = it.image ?? {};
        holdings.push({
          contractAddress: contract,
          tokenId,
          name: it.name ?? it.contract?.name ?? null,
          description: it.description ?? null,
          collectionName: it.contract?.name ?? it.collection?.name ?? null,
          logoUrl: img.cachedUrl ?? img.pngUrl ?? img.thumbnailUrl ?? img.originalUrl ?? null,
          tokenStandard: it.tokenType ?? it.contract?.tokenType ?? null,
        });
      }
      return holdings;
    } catch (e) {
      console.error('[wallet-data] alchemy getNftHoldings failed', (e as Error).message);
      return null;
    }
  }
}

function hexToHuman(hex: string | null | undefined, decimals: number | null): number {
  if (!hex) return 0;
  let raw: number;
  try {
    raw = Number(BigInt(hex));
  } catch {
    raw = Number(hex);
  }
  if (!Number.isFinite(raw)) return 0;
  return decimals && decimals > 0 ? raw / 10 ** decimals : raw;
}

function extractUsdPrice(
  prices: Array<{ currency?: string; value?: string | number | null }> | null | undefined,
): number | null {
  if (!Array.isArray(prices)) return null;
  const usd = prices.find((p) => (p.currency ?? 'usd').toLowerCase() === 'usd') ?? prices[0];
  if (!usd || usd.value == null) return null;
  const v = Number(usd.value);
  return Number.isFinite(v) ? v : null;
}

// --- transfer history / NFT holdings (retrofit-63, probe-confirmed shapes) -----------------

interface AlchemyTransfer {
  blockNum?: string | null;
  uniqueId?: string | null;
  hash?: string | null;
  from?: string | null;
  to?: string | null;
  value?: number | null; // human-adjusted already (null for NFTs)
  erc721TokenId?: string | null; // hex
  erc1155Metadata?: Array<{ tokenId?: string | null; value?: string | null }> | null;
  tokenId?: string | null; // hex
  asset?: string | null; // symbol (null for NFTs)
  category?: string | null; // 'external' (native) | 'erc20' | 'erc721' | 'erc1155'
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null } | null;
  metadata?: { blockTimestamp?: string | null } | null;
}
interface AlchemyAssetTransfersResult {
  transfers?: AlchemyTransfer[];
  pageKey?: string | null;
}
interface AlchemyNftImage {
  cachedUrl?: string | null;
  pngUrl?: string | null;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
}
interface AlchemyOwnedNft {
  contract?: { address?: string | null; name?: string | null; tokenType?: string | null } | null;
  tokenId?: string | null; // DECIMAL from getNFTsForOwner
  tokenType?: string | null;
  name?: string | null;
  description?: string | null;
  image?: AlchemyNftImage | null;
  collection?: { name?: string | null } | null;
}

// Alchemy transfer tokenIds are hex; the rest of the pipeline (Moralis/GoldRush, the Nft
// @@unique) uses DECIMAL — normalize so the same NFT keys to one row regardless of provider.
function hexToDecimalString(hex: string): string {
  try {
    return BigInt(hex).toString();
  } catch {
    return hex; // already decimal, or unparseable — leave as-is
  }
}

function mapAlchemyTransfer(
  t: AlchemyTransfer,
  wallet: string,
  chainSlug: string,
): WalletTransfer | null {
  const from = t.from ?? null;
  const to = t.to ?? null;
  const direction: 'in' | 'out' = (to ?? '').toLowerCase() === wallet ? 'in' : 'out';
  const ts = t.metadata?.blockTimestamp ?? new Date(0).toISOString();
  const cat = t.category;

  if (cat === 'erc721' || cat === 'erc1155') {
    const contract = (t.rawContract?.address ?? '').toLowerCase();
    const hexId = t.tokenId ?? t.erc721TokenId ?? t.erc1155Metadata?.[0]?.tokenId ?? null;
    const tokenId = hexId ? hexToDecimalString(hexId) : null;
    if (!contract || !tokenId) return null;
    let amount = 1;
    const raw1155 = t.erc1155Metadata?.[0]?.value;
    if (cat === 'erc1155' && raw1155) {
      try {
        const n = Number(BigInt(raw1155));
        if (Number.isFinite(n) && n > 0) amount = n;
      } catch {
        /* keep 1 */
      }
    }
    return {
      type: 'nft',
      direction,
      hash: t.hash ?? null,
      from,
      to,
      symbol: null,
      name: t.asset ?? null,
      contractAddress: contract,
      amount,
      usdValue: null,
      gasFee: null,
      timestamp: ts,
      logoUrl: null,
      nftTokenId: tokenId,
      collectionName: t.asset ?? null,
      description: null,
    };
  }

  // native ('external') or erc20 — value is already human-adjusted; gas/USD not provided.
  const isNative = cat === 'external';
  const symbol = (t.asset ?? (isNative ? NATIVE_SYMBOLS[chainSlug] : '') ?? '').toUpperCase();
  if (!symbol) return null;
  const amount = typeof t.value === 'number' ? t.value : t.value != null ? Number(t.value) : null;
  return {
    type: isNative ? 'native' : 'erc20',
    direction,
    hash: t.hash ?? null,
    from,
    to,
    symbol,
    name: t.asset ?? null,
    contractAddress: isNative ? null : (t.rawContract?.address ?? null),
    amount,
    usdValue: null,
    gasFee: null,
    timestamp: ts,
    logoUrl: null,
    nftTokenId: null,
    collectionName: null,
    description: null,
  };
}
