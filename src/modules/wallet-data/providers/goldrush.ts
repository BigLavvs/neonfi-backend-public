// Neonfi backend — Covalent / GoldRush read-side wallet provider (retrofit-47, fallback 1).
//
// balances_v2 with no-spam=true (provider-side spam filtering) + quote-currency=USD.
// Raw balances are integer strings scaled by contract_decimals. Network/HTTP/parse
// failure → { status: 'error' }.

import WebSocket from 'ws';
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

// retrofit-79 (§1): GoldRush Streaming API (GraphQL-over-WebSocket) — the home of the
// turnkey `upnlForWallet` query (cost basis + realized + unrealized per token). It is a
// QUERY (not a subscription) but only served over the graphql-transport-ws protocol; auth is
// a Bearer header. slug → the `ChainNameUpnl` enum the query takes (probe-confirmed the 7
// supported chains — a SUBSET of COV_CHAIN, so PnL gets its own map). Beta endpoint: we pin
// to the exact fields the probe verified and tolerate schema drift (any miss → null).
const GOLDRUSH_STREAMING_URL = 'wss://streaming.goldrushdata.com/graphql';
const UPNL_TIMEOUT_MS = 60000; // server-side compute is ~30-46s for active wallets; bounded headroom.
const COV_UPNL_CHAIN: Record<string, string> = {
  eth: 'ETH_MAINNET',
  base: 'BASE_MAINNET',
  bnb: 'BSC_MAINNET',
  polygon: 'POLYGON_MAINNET',
  optimism: 'OPTIMISM_MAINNET',
  gnosis: 'GNOSIS_MAINNET',
  solana: 'SOLANA_MAINNET',
};

// slug → Covalent chain name. polygon-zkevm intentionally omitted (uncertain mapping).
const COV_CHAIN: Record<string, string> = {
  eth: 'eth-mainnet',
  polygon: 'matic-mainnet',
  bnb: 'bsc-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  base: 'base-mainnet',
  avalanche: 'avalanche-mainnet',
  fantom: 'fantom-mainnet',
  linea: 'linea-mainnet',
  zksync: 'zksync-mainnet',
  gnosis: 'gnosis-mainnet',
  cronos: 'cronos-mainnet',
  mantle: 'mantle-mainnet',
  solana: 'solana-mainnet',
};

interface CovalentItem {
  contract_ticker_symbol?: string | null;
  contract_name?: string | null;
  contract_decimals?: number | null;
  contract_address?: string | null;
  balance?: string | null;
  quote?: number | null;
  quote_rate?: number | null;
  native_token?: boolean;
}

export class GoldRushWalletProvider implements WalletDataProvider {
  readonly name = 'goldrush';

  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsChain(chainSlug: string): boolean {
    return chainSlug in COV_CHAIN;
  }

  async getSummary(address: string, chainSlug: string): Promise<ProviderResult> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return { status: 'error' };
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/balances_v2/` +
        `?quote-currency=USD&no-spam=true`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return { status: 'error' };
      const json = (await res.json()) as { data?: { items?: CovalentItem[] } };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];

      const kept: WalletToken[] = [];
      for (const it of items) {
        const symbol = (it.contract_ticker_symbol ?? '').toUpperCase();
        if (!symbol) continue;
        const isNative = it.native_token === true;
        const decimals = it.contract_decimals ?? null;
        const balance = humanBalance(it.balance, decimals);
        if (!Number.isFinite(balance) || balance <= 0) continue;
        const usdValue = it.quote != null ? Number(it.quote) : null;
        const usdPrice = it.quote_rate != null ? Number(it.quote_rate) : null;
        if (usdValue == null && !isNative) continue; // unpriced non-native dust
        kept.push({
          symbol,
          name: it.contract_name ?? null,
          contractAddress: isNative ? null : (it.contract_address ?? null),
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
      console.error('[wallet-data] goldrush getSummary failed', (e as Error).message);
      return { status: 'error' };
    }
  }

  // retrofit-79 (§1, PnL PRIMARY): turnkey wallet PnL / cost basis via the Streaming API's
  // `upnlForWallet` GraphQL query. Probe-confirmed shape: a flat list of UpnlWalletItem, each
  // with token_address, cost_basis (per-unit weighted-avg buy price), pnl_realized_usd,
  // pnl_unrealized_usd, and a nested contract_metadata { contract_ticker_symbol,
  // contract_address }. NOTE current_price is unreliable (returns 0), so we ignore it and let
  // derive.ts recompute unrealized from our live prices. Unsupported chain / non-ok / timeout /
  // parse → null so the orchestrator falls through to Moralis. Never throws.
  async getWalletPnl(address: string, chainSlug: string): Promise<WalletPnl | null> {
    const chainEnum = COV_UPNL_CHAIN[chainSlug];
    if (!chainEnum || !this.apiKey) return null;
    // SCALARS ONLY — the nested `contract_metadata` subselection makes the server-side
    // computation far slower (it times out for active wallets), and we don't need the ticker:
    // the sync resolves each item to a catalog token by its on-chain `token_address`. Probe-
    // confirmed this scalar query returns in time where the metadata variant did not.
    const query =
      `query { upnlForWallet(chain_name: ${chainEnum}, wallet_address: "${address}") {` +
      ` token_address cost_basis pnl_realized_usd pnl_unrealized_usd } }`;
    try {
      const data = await this.runStreamingQuery<{ upnlForWallet?: UpnlWalletItem[] }>(query);
      const items = Array.isArray(data?.upnlForWallet) ? data!.upnlForWallet! : null;
      if (!items) return null;
      const tokens: WalletTokenPnl[] = [];
      for (const it of items) {
        const contract = (it.token_address ?? '').toLowerCase();
        if (!contract) continue;
        const symbol = null; // not fetched (metadata subquery is too slow); resolved by contract
        // cost_basis is the per-unit avg buy price of currently-held units; > 0 means the token
        // was genuinely bought (cost-tracked). 0 / null → cost-unknown (transfer-acquired).
        const cb = typeof it.cost_basis === 'number' && Number.isFinite(it.cost_basis) ? it.cost_basis : null;
        tokens.push({
          symbol,
          contractAddress: contract || null,
          avgCost: cb != null && cb > 0 ? cb : null,
          realizedPnlUsd: num(it.pnl_realized_usd),
          unrealizedPnlUsd: num(it.pnl_unrealized_usd),
        });
      }
      return { provider: this.name, tokens };
    } catch (e) {
      console.error('[wallet-data] goldrush getWalletPnl failed', (e as Error).message);
      return null;
    }
  }

  // One-shot GraphQL-over-WebSocket (graphql-transport-ws) query: connect with a Bearer header,
  // connection_init → connection_ack → subscribe → first `next` → resolve its data, then close.
  // Any error/complete-without-data/close/timeout resolves null (best-effort, never throws out).
  private runStreamingQuery<T>(query: string): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const finish = (r: T | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(r);
      };
      const ws = new WebSocket(GOLDRUSH_STREAMING_URL, 'graphql-transport-ws', {
        headers: { Authorization: `Bearer ${this.apiKey!}` },
      });
      const timer = setTimeout(() => finish(null), UPNL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} })));
      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: { type?: string; payload?: { data?: T; errors?: unknown } };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'connection_ack') {
          ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query } }));
        } else if (msg.type === 'ping') {
          // graphql-transport-ws keepalive — the server stalls result delivery if we don't pong.
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'next') {
          if (msg.payload?.errors) {
            console.error('[wallet-data] goldrush uPnL query errors', JSON.stringify(msg.payload.errors).slice(0, 300));
          }
          finish(msg.payload?.data ?? null);
        } else if (msg.type === 'error' || msg.type === 'complete' || msg.type === 'connection_error') {
          finish(null);
        }
      });
      ws.on('error', () => finish(null));
      ws.on('close', () => finish(null));
    });
  }

  // retrofit-56: the wallet's REAL on-chain tx total. Probe-confirmed shape:
  // transactions_summary → data.items[0].total_count. null on non-ok/parse failure
  // (callers fall back to the imported DB row count).
  async getTransactionCount(address: string, chainSlug: string): Promise<number | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/transactions_summary/` +
        `?quote-currency=USD`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { items?: Array<{ total_count?: number | null }> } };
      const total = json.data?.items?.[0]?.total_count;
      return typeof total === 'number' && Number.isFinite(total) ? total : null;
    } catch (e) {
      console.error('[wallet-data] goldrush getTransactionCount failed', (e as Error).message);
      return null;
    }
  }

  // retrofit-56: daily portfolio USD value for the last `days` days, for BalanceSnapshot
  // backfill. Probe-confirmed shape: portfolio_v2 → data.items[] is PER-TOKEN, each with a
  // daily holdings[] (days+1 entries, newest-first), holdings[].timestamp (ISO) +
  // holdings[].close.quote (USD). Sum close.quote across all tokens per date → one series,
  // ASC by date. null on non-ok/parse/empty (caller skips the backfill).
  async getValueHistory(
    address: string,
    chainSlug: string,
    days: number,
  ): Promise<Array<{ date: string; value: number }> | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov) return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/portfolio_v2/` +
        `?quote-currency=USD&days=${days}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { items?: Array<{ holdings?: Array<CovalentHolding> }> };
      };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];
      const byDate = new Map<string, number>();
      for (const token of items) {
        for (const h of token.holdings ?? []) {
          if (!h.timestamp) continue;
          const date = h.timestamp.slice(0, 10); // 'YYYY-MM-DD'
          const q = h.close?.quote;
          if (q == null || !Number.isFinite(Number(q))) continue;
          byDate.set(date, (byDate.get(date) ?? 0) + Number(q));
        }
      }
      if (byDate.size === 0) return null;
      // 'YYYY-MM-DD' sorts lexicographically == chronologically.
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, value]) => ({ date, value }));
    } catch (e) {
      console.error('[wallet-data] goldrush getValueHistory failed', (e as Error).message);
      return null;
    }
  }

  // retrofit-63: real transfer history (fallback behind Moralis). transactions_v3 returns
  // decoded txs newest-first; each carries the native value + raw `log_events`. We surface
  // three kinds of WalletTransfer per tx: the native value move, ERC-20 Transfer logs, and
  // NFT (ERC-721 Transfer / ERC-1155 TransferSingle) logs — but ONLY legs where the wallet is
  // a party (log_events also include transfers between OTHER addresses in the same tx, e.g. a
  // DEX routing through pools). Pagination is GoldRush's `data.links.prev` URL (older txs),
  // which we pass straight back as the opaque cursor. Solana / unmapped chain / non-2xx /
  // parse error → null so the orchestrator falls through (Moralis stays primary).
  async getTransferHistory(
    address: string,
    chainSlug: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<TransferPage | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov || chainSlug === 'solana') return null;
    const wallet = address.toLowerCase();
    try {
      // First page: the default transactions_v3 endpoint (newest-first). Continuation:
      // opts.cursor is the full `links.prev` URL GoldRush handed back (the next-older page).
      const url =
        opts.cursor && /^https?:\/\//.test(opts.cursor)
          ? opts.cursor
          : `https://api.covalenthq.com/v1/${cov}/address/${address}/transactions_v3/` +
            `?quote-currency=USD&page-size=100`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as CovTxResponse;
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];

      const transfers: WalletTransfer[] = [];
      const nativeSym = (NATIVE_SYMBOLS[chainSlug] ?? '').toUpperCase();
      for (const it of items) {
        const ts = it.block_signed_at ?? new Date(0).toISOString();
        const hash = it.tx_hash ?? null;
        const txFrom = (it.from_address ?? '').toLowerCase();
        const txTo = (it.to_address ?? '').toLowerCase();
        // Attach the tx-level gas (native units) to the FIRST emitted leg only, so summing the
        // per-row gas back up equals the real fee (a multi-leg tx paid gas once).
        let gasAttached = false;
        const gas = humanBalance(it.fees_paid, 18);
        const takeGas = (): number | null => {
          if (gasAttached) return null;
          gasAttached = true;
          return gas > 0 ? gas : null;
        };

        // Native value moved by the tx itself (skip pure contract calls where value == 0).
        const nativeAmount = humanBalance(it.value, it.gas_metadata?.contract_decimals ?? 18);
        if (nativeAmount > 0 && (txFrom === wallet || txTo === wallet)) {
          transfers.push({
            type: 'native',
            direction: txTo === wallet ? 'in' : 'out',
            hash,
            from: it.from_address ?? null,
            to: it.to_address ?? null,
            symbol: (it.gas_metadata?.contract_ticker_symbol ?? nativeSym).toUpperCase() || null,
            name: it.gas_metadata?.contract_ticker_symbol ?? null,
            contractAddress: null,
            amount: nativeAmount,
            usdValue: it.value_quote ?? null,
            gasFee: takeGas(),
            timestamp: ts,
            logoUrl: null,
            nftTokenId: null,
            collectionName: null,
            description: null,
          });
        }

        for (const le of it.log_events ?? []) {
          const dec = le.decoded;
          if (!dec || !dec.name) continue;
          const params = dec.params ?? [];
          const pVal = (name: string): string | null => {
            const v = params.find((p) => p.name === name)?.value;
            return v == null ? null : String(v);
          };

          if (dec.name === 'Transfer') {
            // ERC-20 (3rd param `value`) vs ERC-721 (3rd param `tokenId`). `supports_erc` is
            // unreliable here (it lists erc20 for ENS ERC-721s), so classify by param shape.
            const third = params[2];
            const logFrom = (pVal('from') ?? '').toLowerCase();
            const logTo = (pVal('to') ?? '').toLowerCase();
            if (logFrom !== wallet && logTo !== wallet) continue; // not the wallet's transfer
            const direction = logTo === wallet ? 'in' : 'out';
            if (third?.name === 'value') {
              const sym = (le.sender_contract_ticker_symbol ?? '').toUpperCase();
              if (!sym) continue;
              transfers.push({
                type: 'erc20',
                direction,
                hash,
                from: pVal('from'),
                to: pVal('to'),
                symbol: sym,
                name: le.sender_name ?? sym,
                contractAddress: le.sender_address ?? null,
                amount: humanBalance(pVal('value'), le.sender_contract_decimals ?? 0),
                usdValue: null, // transactions_v3 doesn't price individual log events
                gasFee: takeGas(),
                timestamp: ts,
                logoUrl: le.sender_logo_url ?? null,
                nftTokenId: null,
                collectionName: null,
                description: null,
              });
            } else if (third?.name === 'tokenId') {
              const tokenId = pVal('tokenId');
              if (!tokenId) continue;
              transfers.push(
                this.nftLeg(le, hash, direction, pVal('from'), pVal('to'), tokenId, 1, ts),
              );
            }
          } else if (dec.name === 'TransferSingle') {
            const logFrom = (pVal('_from') ?? '').toLowerCase();
            const logTo = (pVal('_to') ?? '').toLowerCase();
            if (logFrom !== wallet && logTo !== wallet) continue;
            const tokenId = pVal('_id');
            if (!tokenId) continue;
            const amount = Number(pVal('_amount'));
            transfers.push(
              this.nftLeg(
                le,
                hash,
                logTo === wallet ? 'in' : 'out',
                pVal('_from'),
                pVal('_to'),
                tokenId,
                Number.isFinite(amount) && amount > 0 ? amount : 1,
                ts,
              ),
            );
          }
          // TransferBatch (ERC-1155 multi-id) intentionally skipped — rare, array-shaped, and
          // these are overwhelmingly spam airdrops; the holdings list comes from balances_nft.
        }
      }

      return { transfers, nextCursor: json.data?.links?.prev ?? null, totalCount: null };
    } catch (e) {
      console.error('[wallet-data] goldrush getTransferHistory failed', (e as Error).message);
      return null;
    }
  }

  private nftLeg(
    le: CovLogEvent,
    hash: string | null,
    direction: 'in' | 'out',
    from: string | null,
    to: string | null,
    tokenId: string,
    amount: number,
    ts: string,
  ): WalletTransfer {
    return {
      type: 'nft',
      direction,
      hash,
      from,
      to,
      symbol: null,
      name: le.sender_name ?? le.sender_contract_ticker_symbol ?? null,
      contractAddress: le.sender_address ?? null,
      amount,
      usdValue: null,
      gasFee: null, // gas is attached to the tx's native/erc20 first leg, never the nft leg
      timestamp: ts,
      logoUrl: le.sender_logo_url ?? null,
      nftTokenId: tokenId,
      collectionName: le.sender_name ?? null,
      description: null,
    };
  }

  // retrofit-63: current NFT holdings (fallback behind Moralis). balances_nft groups by
  // collection (data.items[]), each with a nft_data[] of held tokens. token_id is already
  // DECIMAL (matches Moralis format=decimal + the decimal tokenIds the transfer import writes,
  // so the Nft @@unique doesn't dupe). no-spam=true mirrors getSummary. Non-2xx / parse → null.
  async getNftHoldings(address: string, chainSlug: string): Promise<WalletNftHolding[] | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov || chainSlug === 'solana') return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/balances_nft/` + `?no-spam=true`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { items?: CovNftItem[] } };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];
      const holdings: WalletNftHolding[] = [];
      for (const c of items) {
        if (c.is_spam === true) continue;
        const contract = (c.contract_address ?? '').toLowerCase();
        if (!contract) continue;
        const ercs = c.supports_erc ?? [];
        const tokenStandard = ercs.includes('erc1155')
          ? 'ERC1155'
          : ercs.includes('erc721')
            ? 'ERC721'
            : null;
        for (const t of c.nft_data ?? []) {
          const tokenId = t.token_id ?? '';
          if (!tokenId) continue;
          if (t.token_balance != null && Number(t.token_balance) <= 0) continue;
          const ed = t.external_data ?? {};
          holdings.push({
            contractAddress: contract,
            tokenId,
            name: ed.name ?? c.contract_name ?? null,
            description: ed.description ?? null,
            collectionName: c.contract_name ?? null,
            logoUrl: ed.image_512 ?? ed.image ?? ed.image_preview ?? null,
            tokenStandard,
            possibleSpam: false, // retrofit-73 (H13): GoldRush already drops is_spam rows above
          });
        }
      }
      return holdings;
    } catch (e) {
      console.error('[wallet-data] goldrush getNftHoldings failed', (e as Error).message);
      return null;
    }
  }

  // retrofit-86 (H13.1): GoldRush's spam classification is PER-WALLET (balances_nft.is_spam), not a
  // chain-global DB — so this is the wallet-scoped spam-contract source the orchestrator unions in
  // (defect #1: previously NOTHING wired GoldRush spam, leaving the whole signal on the plan-gated
  // Alchemy list). We re-query balances_nft with no-spam=FALSE (getNftHoldings uses no-spam=true,
  // which DROPS the flagged rows) and collect every contract GoldRush marks is_spam. Returns
  // LOWERCASED contracts; null on unsupported chain / non-2xx / parse (caller treats as no signal).
  async getWalletSpamContracts(address: string, chainSlug: string): Promise<Set<string> | null> {
    const cov = COV_CHAIN[chainSlug];
    if (!cov || chainSlug === 'solana') return null;
    try {
      const url =
        `https://api.covalenthq.com/v1/${cov}/address/${address}/balances_nft/` + `?no-spam=false`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { items?: CovNftItem[] } };
      const items = Array.isArray(json.data?.items) ? json.data!.items! : [];
      const out = new Set<string>();
      for (const c of items) {
        if (c.is_spam === true && c.contract_address) out.add(c.contract_address.toLowerCase());
      }
      return out;
    } catch (e) {
      console.error('[wallet-data] goldrush getWalletSpamContracts failed', (e as Error).message);
      return null;
    }
  }
}

// portfolio_v2 daily holding entry (probe-confirmed: open/high/low/close each carry a USD
// `quote`; we read the day's close).
interface CovalentHolding {
  timestamp?: string | null;
  close?: { quote?: number | null } | null;
}

// transactions_v3 (retrofit-63, probe-confirmed shapes) -----------------------
interface CovDecodedParam {
  name?: string | null;
  type?: string | null;
  value?: unknown;
}
interface CovLogEvent {
  sender_address?: string | null;
  sender_name?: string | null;
  sender_contract_ticker_symbol?: string | null;
  sender_contract_decimals?: number | null;
  sender_logo_url?: string | null;
  decoded?: { name?: string | null; params?: CovDecodedParam[] | null } | null;
}
interface CovTxItem {
  block_signed_at?: string | null;
  tx_hash?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  value?: string | null; // raw native (wei)
  value_quote?: number | null; // historical USD of the native move
  fees_paid?: string | null; // raw native gas (wei)
  gas_metadata?: { contract_decimals?: number | null; contract_ticker_symbol?: string | null } | null;
  log_events?: CovLogEvent[] | null;
}
interface CovTxResponse {
  data?: {
    links?: { prev?: string | null; next?: string | null } | null;
    items?: CovTxItem[] | null;
  } | null;
}

// balances_nft (retrofit-63) --------------------------------------------------
interface CovNftExternalData {
  name?: string | null;
  description?: string | null;
  image?: string | null;
  image_512?: string | null;
  image_preview?: string | null;
}
interface CovNftData {
  token_id?: string | null;
  token_balance?: string | null;
  external_data?: CovNftExternalData | null;
}
interface CovNftItem {
  contract_name?: string | null;
  contract_address?: string | null;
  supports_erc?: string[] | null;
  is_spam?: boolean;
  nft_data?: CovNftData[] | null;
}

// upnlForWallet item (retrofit-79 §1, probe-confirmed: UpnlWalletItem fields are snake_case;
// cost_basis/current_price/pnl_*_usd are Float; contract_metadata is a nested object).
interface UpnlWalletItem {
  token_address?: string | null;
  cost_basis?: number | null;
  pnl_realized_usd?: number | null;
  pnl_unrealized_usd?: number | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Covalent returns the raw integer balance as a string; divide by 10^decimals.
function humanBalance(raw: string | null | undefined, decimals: number | null): number {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return decimals && decimals > 0 ? n / 10 ** decimals : n;
}
