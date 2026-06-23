// Neonfi backend — Moralis read-side wallet provider (retrofit-47, PRIMARY).
//
// Reads the wallet via the Moralis Web3 Data API (NOT the Streams API — that stays
// untouched). EVM via the deep-index `/wallets/{address}/tokens` endpoint keyed by the
// chain hex (chains.constants moralisId); Solana via the solana-gateway portfolio
// endpoint. Network/HTTP/parse failure → { status: 'error' } (never throws out).

import { CHAINS } from '../../chains/chains.constants.js';
import type {
  ProviderResult,
  TransferPage,
  WalletDataProvider,
  WalletNftHolding,
  WalletPnl,
  WalletToken,
  WalletTokenPnl,
  WalletTransfer,
} from '../types.js';
import { buildSummary, NATIVE_SYMBOLS } from '../build-summary.js';

// slug → Moralis chain identifier (hex for EVM, 'solana' for Solana).
const CHAIN_ID = new Map(CHAINS.map((c) => [c.slug, c.moralisId]));

// retrofit-79 (§1): the Moralis wallet-PnL endpoints (the GA fallback behind GoldRush) only
// cover these EVM chains. Moralis is realized-only (weighted-average cost basis), so we read
// avg_buy_price_usd as avgCost and leave unrealized for derive.ts to compute from live prices.
const MORALIS_PNL_CHAINS = new Set(['eth', 'polygon', 'base']);

// One token row from /wallets/{address}/profitability (per-token breakdown).
interface MoralisProfitabilityToken {
  token_address?: string | null;
  symbol?: string | null;
  name?: string | null;
  avg_buy_price_usd?: number | string | null;
  realized_profit_usd?: number | string | null;
  total_usd_invested?: number | string | null;
}
interface MoralisProfitabilityResponse {
  result?: MoralisProfitabilityToken[];
}

interface MoralisEvmToken {
  symbol?: string;
  name?: string;
  token_address?: string | null;
  decimals?: number | string | null;
  balance_formatted?: string;
  usd_value?: number | string | null;
  usd_price?: number | string | null;
  native_token?: boolean;
  possible_spam?: boolean;
}

interface MoralisSolanaPortfolio {
  nativeBalance?: { solana?: string };
  tokens?: Array<{
    symbol?: string;
    name?: string;
    associatedTokenAddress?: string;
    amount?: string;
    decimals?: number;
  }>;
}

// --- Wallet history endpoint (retrofit-49) -----------------------------------
// /wallets/{address}/history returns one decoded item per tx, each carrying nested
// native/erc20/nft transfer arrays. Every field is optional — Moralis omits prices,
// logos, and names when it can't resolve them.
interface MoralisHistoryNativeTransfer {
  from_address?: string | null;
  to_address?: string | null;
  value_formatted?: string | null;
  value?: string | null;
  token_symbol?: string | null;
  token_logo?: string | null;
  value_usd?: number | string | null;
}
interface MoralisHistoryErc20Transfer {
  from_address?: string | null;
  to_address?: string | null;
  value_formatted?: string | null;
  token_symbol?: string | null;
  token_name?: string | null;
  address?: string | null; // token contract
  token_logo?: string | null;
  value_usd?: number | string | null;
}
interface MoralisHistoryNftTransfer {
  from_address?: string | null;
  to_address?: string | null;
  token_address?: string | null;
  token_id?: string | null;
  token_ids?: string[] | null;
  amount?: string | null;
  token_name?: string | null;
  collection_name?: string | null;
  collection_logo?: string | null;
  contract_type?: string | null;
  normalized_metadata?: { description?: string | null } | null;
}
interface MoralisHistoryItem {
  hash?: string | null;
  block_timestamp?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  transaction_fee?: string | null;
  native_transfers?: MoralisHistoryNativeTransfer[] | null;
  erc20_transfers?: MoralisHistoryErc20Transfer[] | null;
  nft_transfers?: MoralisHistoryNftTransfer[] | null;
}
interface MoralisHistoryResponse {
  result?: MoralisHistoryItem[];
  cursor?: string | null;
  total?: number | null;
}

// /wallets/{address}/nfts — current NFT holdings.
interface MoralisNftHolding {
  token_address?: string | null;
  token_id?: string | null;
  name?: string | null;
  contract_type?: string | null;
  collection_logo?: string | null;
  possible_spam?: boolean; // retrofit-73 (H13): provider-flagged airdrop/scam NFT
  normalized_metadata?: { name?: string | null; image?: string | null; description?: string | null } | null;
  // Moralis-cached media (only present when media_items=true). The CDN URLs here are far
  // more reliable than the raw IPFS/HTTP image in normalized_metadata (which often 404s).
  media?: {
    original_media_url?: string | null;
    media_collection?: {
      low?: { url?: string | null } | null;
      medium?: { url?: string | null } | null;
      high?: { url?: string | null } | null;
    } | null;
  } | null;
}
interface MoralisNftHoldingsResponse {
  result?: MoralisNftHolding[];
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Raw `ipfs://` URLs won't load in an <img>; rewrite to a public gateway. Already-HTTP
// URLs pass through unchanged. audit SEC #26: the path after `ipfs://` is provider-sourced,
// so strip anything outside the CID/sub-path charset and length-cap it before splicing into
// the fixed gateway host — a hostile path can't smuggle a query string or traversal.
function toHttpImage(u: string | null | undefined): string | null {
  if (!u) return null;
  if (u.startsWith('ipfs://')) {
    const cleaned = u
      .slice(7)
      .replace(/^ipfs\//, '')
      .replace(/[^A-Za-z0-9/._-]/g, '')
      .slice(0, 512);
    return cleaned ? `https://ipfs.io/ipfs/${cleaned}` : null;
  }
  return u;
}

export class MoralisWalletProvider implements WalletDataProvider {
  readonly name = 'moralis';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly deepIndexBase: string,
    private readonly solanaBase: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    // Moralis covers every catalog chain — EVM via hex, Solana via the gateway.
    return CHAIN_ID.has(chainSlug);
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    try {
      return chainSlug === 'solana'
        ? await this.getSolana(address)
        : await this.getEvm(address, chainSlug);
    } catch (e) {
      console.error('[wallet-data] moralis getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey!, accept: 'application/json' };
  }

  private async getEvm(address: string, chainSlug: string): Promise<ProviderResult> {
    const hex = CHAIN_ID.get(chainSlug);
    if (!hex) return { status: 'error' };
    const url = `${this.deepIndexBase}/wallets/${address}/tokens?chain=${hex}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return { status: 'error' };
    const json = (await res.json()) as { result?: MoralisEvmToken[] };
    const items = Array.isArray(json.result) ? json.result : [];

    const kept: WalletToken[] = [];
    for (const it of items) {
      if (it.possible_spam === true) continue; // provider-flagged spam
      const symbol = (it.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const isNative = it.native_token === true;
      const balance = Number(it.balance_formatted ?? '0');
      if (!Number.isFinite(balance) || balance <= 0) continue;
      const usdValue = it.usd_value != null ? Number(it.usd_value) : null;
      const usdPrice = it.usd_price != null ? Number(it.usd_price) : null;
      // Unpriced non-native token → almost always junk/dust → drop. Native always kept.
      if (usdValue == null && !isNative) continue;
      kept.push({
        symbol,
        name: it.name ?? null,
        contractAddress: isNative ? null : (it.token_address ?? null),
        balance,
        decimals: it.decimals != null ? Number(it.decimals) : null,
        usdPrice,
        usdValue,
        isNative,
      });
    }

    if (kept.length === 0) return { status: 'empty' };
    return { status: 'ok', summary: buildSummary(this.name, kept, NATIVE_SYMBOLS[chainSlug] ?? '') };
  }

  private async getSolana(address: string): Promise<ProviderResult> {
    const url = `${this.solanaBase}/account/mainnet/${address}/portfolio`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return { status: 'error' };
    const json = (await res.json()) as MoralisSolanaPortfolio;

    const kept: WalletToken[] = [];
    const solBalance = Number(json.nativeBalance?.solana ?? '0');
    if (Number.isFinite(solBalance) && solBalance > 0) {
      kept.push({
        symbol: 'SOL',
        name: 'Solana',
        contractAddress: null,
        balance: solBalance,
        decimals: 9,
        usdPrice: null,
        usdValue: null,
        isNative: true,
      });
    }
    // The Solana portfolio endpoint returns NO USD, so the "unpriced non-native = dust"
    // rule can't apply here (it would nuke every real SPL holding). Keep SPL tokens with
    // a positive balance; totalUsd stays null but balances + count are still accurate.
    for (const t of json.tokens ?? []) {
      const symbol = (t.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const balance = Number(t.amount ?? '0');
      if (!Number.isFinite(balance) || balance <= 0) continue;
      kept.push({
        symbol,
        name: t.name ?? null,
        contractAddress: t.associatedTokenAddress ?? null,
        balance,
        decimals: t.decimals ?? null,
        usdPrice: null,
        usdValue: null,
        isNative: false,
      });
    }

    if (kept.length === 0) return { status: 'empty' };
    return { status: 'ok', summary: buildSummary(this.name, kept, 'SOL') };
  }

  // --- Wallet PnL / cost basis (retrofit-79 §1, GA fallback behind GoldRush) ---
  // /wallets/{address}/profitability returns a per-token breakdown with a weighted-average
  // cost basis (avg_buy_price_usd) + realized PnL (realized_profit_usd). Moralis is realized-
  // only, so unrealized is left null for derive.ts to compute from our live prices. Solana +
  // chains outside MORALIS_PNL_CHAINS, non-ok, or parse failure → null (orchestrator already
  // tried GoldRush first; a Moralis miss means the connected portfolio degrades to "—").
  async getWalletPnl(address: string, chainSlug: string): Promise<WalletPnl | null> {
    if (!MORALIS_PNL_CHAINS.has(chainSlug)) return null;
    const hex = CHAIN_ID.get(chainSlug);
    if (!hex) return null;
    try {
      const url = `${this.deepIndexBase}/wallets/${address}/profitability?chain=${hex}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) return null;
      const json = (await res.json()) as MoralisProfitabilityResponse;
      const items = Array.isArray(json.result) ? json.result : [];
      const tokens: WalletTokenPnl[] = [];
      for (const it of items) {
        const contract = (it.token_address ?? '').toLowerCase();
        const symbol = it.symbol ? it.symbol.toUpperCase() : null;
        if (!contract && !symbol) continue;
        const avg = toNum(it.avg_buy_price_usd);
        tokens.push({
          symbol,
          contractAddress: contract || null,
          avgCost: avg != null && avg > 0 ? avg : null,
          realizedPnlUsd: toNum(it.realized_profit_usd),
          unrealizedPnlUsd: null, // Moralis is realized-only; derive computes unrealized
        });
      }
      return { provider: this.name, tokens };
    } catch (e) {
      console.error('[wallet-data] moralis getWalletPnl failed', (e as Error).message);
      return null;
    }
  }

  // --- Transfer history (retrofit-49) ----------------------------------------
  // Pulls one page of the wallet's REAL transfers (native + ERC-20 + NFT) with their block
  // time, hash, from/to, gas, amount, and historical USD value. Solana is unsupported here
  // (the gateway has no equivalent decoded-history endpoint) → null, so the orchestrator
  // falls through and the sync degrades to opening-lot-only. Network/HTTP/parse failure →
  // null (never throws): a missing history must not abort portfolio creation.
  async getTransferHistory(
    address: string,
    chainSlug: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<TransferPage | null> {
    if (chainSlug === 'solana') return null;
    const hex = CHAIN_ID.get(chainSlug);
    if (!hex) return null;
    const limit = opts.limit ?? 100;
    const wallet = address.toLowerCase();
    try {
      const params = new URLSearchParams({ chain: hex, order: 'DESC', limit: String(limit) });
      // nft_metadata=true lets the decoded NFT transfers carry normalized_metadata (so the
      // history path's description can populate). Cheap; the displayed NFTs still come from
      // getNftHoldings, not transfers.
      params.set('nft_metadata', 'true');
      if (opts.cursor) params.set('cursor', opts.cursor);
      const url = `${this.deepIndexBase}/wallets/${address}/history?${params.toString()}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) return null;
      const json = (await res.json()) as MoralisHistoryResponse;
      const items = Array.isArray(json.result) ? json.result : [];

      const transfers: WalletTransfer[] = [];
      for (const item of items) {
        const ts = item.block_timestamp ?? new Date(0).toISOString();
        const gas = toNum(item.transaction_fee);
        // Attach the tx-level gas to the FIRST leg of the tx only, so summing the row gas
        // back up equals the real fee (a tx with several transfers paid gas once).
        let gasAttached = false;
        const takeGas = (): number | null => {
          if (gasAttached) return null;
          gasAttached = true;
          return gas;
        };
        const dirOf = (to: string | null | undefined): 'in' | 'out' =>
          (to ?? '').toLowerCase() === wallet ? 'in' : 'out';

        for (const t of item.native_transfers ?? []) {
          transfers.push({
            type: 'native',
            direction: dirOf(t.to_address),
            hash: item.hash ?? null,
            from: t.from_address ?? null,
            to: t.to_address ?? null,
            symbol: (t.token_symbol ?? NATIVE_SYMBOLS[chainSlug] ?? '').toUpperCase() || null,
            name: t.token_symbol ?? null,
            contractAddress: null,
            amount: toNum(t.value_formatted),
            usdValue: toNum(t.value_usd),
            gasFee: takeGas(),
            timestamp: ts,
            logoUrl: t.token_logo ?? null,
            nftTokenId: null,
            collectionName: null,
            description: null,
          });
        }
        for (const t of item.erc20_transfers ?? []) {
          transfers.push({
            type: 'erc20',
            direction: dirOf(t.to_address),
            hash: item.hash ?? null,
            from: t.from_address ?? null,
            to: t.to_address ?? null,
            symbol: (t.token_symbol ?? '').toUpperCase() || null,
            name: t.token_name ?? t.token_symbol ?? null,
            contractAddress: t.address ?? null,
            amount: toNum(t.value_formatted),
            usdValue: toNum(t.value_usd),
            gasFee: takeGas(),
            timestamp: ts,
            logoUrl: t.token_logo ?? null,
            nftTokenId: null,
            collectionName: null,
            description: null,
          });
        }
        for (const t of item.nft_transfers ?? []) {
          const tokenId = t.token_id ?? (Array.isArray(t.token_ids) ? t.token_ids[0] : null) ?? null;
          transfers.push({
            type: 'nft',
            direction: dirOf(t.to_address),
            hash: item.hash ?? null,
            from: t.from_address ?? null,
            to: t.to_address ?? null,
            symbol: null,
            name: t.token_name ?? t.collection_name ?? null,
            contractAddress: t.token_address ?? null,
            amount: toNum(t.amount) ?? 1,
            usdValue: null,
            gasFee: takeGas(),
            timestamp: ts,
            logoUrl: t.collection_logo ?? null,
            nftTokenId: tokenId,
            collectionName: t.collection_name ?? null,
            // Best-effort: history rarely carries token metadata; null unless present.
            description: t.normalized_metadata?.description ?? null,
          });
        }
      }

      return {
        transfers,
        nextCursor: json.cursor ?? null,
        // Moralis history doesn't always expose a cheap total; surface it when present, else
        // null (the count falls back to the imported DB row count, §4).
        totalCount: toNum(json.total),
      };
    } catch (e) {
      console.error('[wallet-data] moralis getTransferHistory failed', (e as Error).message);
      return null;
    }
  }

  // --- Current NFT holdings (retrofit-49) -------------------------------------
  // The transfer window only covers recent transfers, so NFTs acquired earlier won't appear
  // there — pull the wallet's current NFT set directly. Solana unsupported → null.
  async getNftHoldings(address: string, chainSlug: string): Promise<WalletNftHolding[] | null> {
    if (chainSlug === 'solana') return null;
    const hex = CHAIN_ID.get(chainSlug);
    if (!hex) return null;
    try {
      // normalizeMetadata=true → Moralis returns normalized_metadata (name/image/description);
      // media_items=true → adds the Moralis-cached `media` CDN object. Without these the image
      // and description fields are always absent. (No exclude_spam — we never drop wallet NFTs.)
      // PATH (retrofit-54): Moralis v2.2 NFTs-by-wallet is `/{address}/nft` (singular, NO `/wallets/`
      // prefix). The `/wallets/{address}/nfts` path 404s ("Cannot GET") — tokens+history use the
      // `/wallets/` namespace but NFTs do not. format=decimal pins token_id to decimal so this
      // holdings upsert matches the decimal tokenIds the transfer-history import already wrote
      // (the Nft @@unique is on tokenId — a hex id would insert a duplicate row).
      const url = `${this.deepIndexBase}/${address}/nft?chain=${hex}&format=decimal&normalizeMetadata=true&media_items=true`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) return null;
      const json = (await res.json()) as MoralisNftHoldingsResponse;
      const items = Array.isArray(json.result) ? json.result : [];
      const holdings: WalletNftHolding[] = [];
      for (const it of items) {
        const contractAddress = (it.token_address ?? '').toLowerCase();
        const tokenId = it.token_id ?? '';
        if (!contractAddress || !tokenId) continue;
        // Prefer the Moralis CDN media (best→worst resolution) over the raw metadata image.
        const media = it.media;
        const mediaUrl =
          media?.media_collection?.high?.url ??
          media?.media_collection?.medium?.url ??
          media?.original_media_url ??
          null;
        holdings.push({
          contractAddress,
          tokenId,
          name: it.normalized_metadata?.name ?? it.name ?? null,
          description: it.normalized_metadata?.description ?? null,
          collectionName: it.name ?? null,
          logoUrl: mediaUrl ?? toHttpImage(it.normalized_metadata?.image) ?? it.collection_logo ?? null,
          tokenStandard: it.contract_type ?? null,
          possibleSpam: it.possible_spam === true, // retrofit-73 (H13)
        });
      }
      return holdings;
    } catch (e) {
      console.error('[wallet-data] moralis getNftHoldings failed', (e as Error).message);
      return null;
    }
  }
}
