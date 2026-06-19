// Neonfi backend — wallet-data provider parsers + orchestrator (retrofit-47).
//
// Pure unit tests: each provider's getSummary is exercised against a stubbed global
// fetch (no real Moralis/Covalent/Alchemy/Ankr calls), and previewWallet is exercised
// against in-memory fake providers (configured/unconfigured, ok/empty/error ordering,
// invalid address). No DB / Redis — mirrors token-catalog-ingest.test.ts.

import { it, expect, describe, vi, afterEach } from 'vitest';

import { MoralisWalletProvider } from '../src/modules/wallet-data/providers/moralis.js';
import { GoldRushWalletProvider } from '../src/modules/wallet-data/providers/goldrush.js';
import { AlchemyWalletProvider } from '../src/modules/wallet-data/providers/alchemy.js';
import { AnkrWalletProvider } from '../src/modules/wallet-data/providers/ankr.js';
import { previewWallet, fetchWalletSummary } from '../src/modules/wallet-data/index.js';
import { sumHistoricalTokenValue } from '../src/modules/wallet-data/sync.js';
import type {
  ProviderResult,
  WalletDataProvider,
} from '../src/modules/wallet-data/types.js';

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const out = handler(String(url), init);
      return out as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// retrofit-72 (H11) — historical value sampler de-spams before summing
// ---------------------------------------------------------------------------

describe('sumHistoricalTokenValue', () => {
  it('drops provider-flagged spam and unpriced/non-finite/non-positive rows; sums the rest', () => {
    const rows = [
      { usd_value: 10, possible_spam: false }, // real
      { usd_value: 2.5 }, // real (no spam flag)
      { usd_value: 999999, possible_spam: true }, // scam token with bogus value → dropped
      { usd_value: null }, // unpriced → dropped
      { usd_value: 0 }, // zero → dropped
      { usd_value: '7.5' }, // string price → counted
      { usd_value: 'not-a-number' }, // non-finite → dropped
    ];
    expect(sumHistoricalTokenValue(rows)).toBeCloseTo(20, 8); // 10 + 2.5 + 7.5
  });

  it('an all-spam list sums to 0 (no phantom value)', () => {
    expect(
      sumHistoricalTokenValue([
        { usd_value: 169, possible_spam: true },
        { usd_value: 2934, possible_spam: true },
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Moralis — EVM
// ---------------------------------------------------------------------------

describe('MoralisWalletProvider — EVM', () => {
  const provider = new MoralisWalletProvider('mk', 'https://deep-index.test/api/v2.2', 'https://solana.test');

  it('parses balances, keeps native, filters spam + unpriced-non-native dust, sorts by usdValue desc', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        result: [
          { symbol: 'ETH', name: 'Ether', token_address: null, decimals: 18, balance_formatted: '1.5', usd_value: 4500, usd_price: 3000, native_token: true },
          { symbol: 'USDC', name: 'USD Coin', token_address: '0xUSDC', decimals: 6, balance_formatted: '100', usd_value: 100, usd_price: 1, native_token: false },
          // provider-flagged spam → excluded
          { symbol: 'SCAM', name: 'Scam', token_address: '0xscam', decimals: 18, balance_formatted: '999999', usd_value: 0, usd_price: 0, native_token: false, possible_spam: true },
          // unpriced non-native → dust → excluded
          { symbol: 'JUNK', name: 'Junk', token_address: '0xjunk', decimals: 18, balance_formatted: '1000', usd_value: null, usd_price: null, native_token: false },
          // zero balance → excluded
          { symbol: 'ZERO', name: 'Zero', token_address: '0xzero', decimals: 18, balance_formatted: '0', usd_value: null, usd_price: null, native_token: false },
        ],
      }),
    }));

    const r = await provider.getSummary('0xabc', 'eth');
    expect(r.status).toBe('ok');
    const s = r.summary!;
    expect(s.provider).toBe('moralis');
    expect(s.nativeSymbol).toBe('ETH');
    expect(s.nativeBalance).toBe(1.5);
    expect(s.totalUsd).toBe(4600);
    expect(s.tokenCount).toBe(2);
    expect(s.tokens.map((t) => t.symbol)).toEqual(['ETH', 'USDC']); // usdValue desc
    expect(s.tokens[0]!.isNative).toBe(true);
    expect(s.tokens[0]!.contractAddress).toBeNull();
    expect(s.tokens[1]!.contractAddress).toBe('0xUSDC');
  });

  it('hits the deep-index tokens endpoint with the chain hex + X-API-Key header', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: [] }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await provider.getSummary('0xabc', 'eth');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://deep-index.test/api/v2.2/wallets/0xabc/tokens?chain=0x1');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('mk');
  });

  it('empty result → status empty', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ result: [] }) }));
    expect((await provider.getSummary('0xabc', 'eth')).status).toBe('empty');
  });

  it('non-ok HTTP → status error', async () => {
    stubFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
    expect((await provider.getSummary('0xabc', 'eth')).status).toBe('error');
  });

  it('fetch throws → status error (never propagates)', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });
    expect((await provider.getSummary('0xabc', 'eth')).status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Moralis — Solana (no USD; keep SPL tokens with positive balance)
// ---------------------------------------------------------------------------

describe('MoralisWalletProvider — Solana', () => {
  const provider = new MoralisWalletProvider('mk', 'https://deep-index.test/api/v2.2', 'https://solana.test');

  it('keeps native SOL + SPL tokens (usdValue null, totalUsd null) and queries the gateway', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nativeBalance: { solana: '2.5' },
        tokens: [
          { symbol: 'BONK', name: 'Bonk', associatedTokenAddress: 'AtA1', amount: '1000', decimals: 5 },
          { symbol: '', amount: '5' }, // blank symbol → skipped
          { symbol: 'NIL', amount: '0' }, // zero balance → skipped
        ],
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const r = await provider.getSummary('SoLaddr', 'solana');
    expect(r.status).toBe('ok');
    const s = r.summary!;
    expect(s.nativeSymbol).toBe('SOL');
    expect(s.nativeBalance).toBe(2.5);
    expect(s.totalUsd).toBeNull();
    expect(s.tokenCount).toBe(2); // SOL + BONK
    expect(s.tokens.find((t) => t.symbol === 'BONK')!.usdValue).toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://solana.test/account/mainnet/SoLaddr/portfolio');
  });

  it('supportsChain covers all catalog chains incl. solana', () => {
    expect(provider.supportsChain('eth')).toBe(true);
    expect(provider.supportsChain('solana')).toBe(true);
    expect(provider.supportsChain('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moralis — NFT holdings (retrofit-52: normalizeMetadata + media_items)
// ---------------------------------------------------------------------------

describe('MoralisWalletProvider — getNftHoldings', () => {
  const provider = new MoralisWalletProvider('mk', 'https://deep-index.test/api/v2.2', 'https://solana.test');

  it('requests normalizeMetadata + media_items and maps media→normalized→collection precedence', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: [
          // CDN media present → high-res URL wins over the raw metadata image.
          {
            token_address: '0xAAA',
            token_id: '1',
            name: 'Coll A',
            contract_type: 'ERC721',
            collection_logo: 'http://logo/a',
            normalized_metadata: { name: 'Alpha', image: 'ipfs://shouldNotWin', description: 'first' },
            media: {
              original_media_url: 'http://cdn/orig',
              media_collection: { low: { url: 'http://cdn/low' }, medium: { url: 'http://cdn/med' }, high: { url: 'http://cdn/high' } },
            },
          },
          // No media → falls back to normalized image, ipfs:// rewritten to a gateway URL.
          {
            token_address: '0xBBB',
            token_id: '2',
            name: 'Coll B',
            contract_type: 'ERC1155',
            collection_logo: 'http://logo/b',
            normalized_metadata: { name: 'Beta', image: 'ipfs://bafyHash/img.png', description: null },
          },
          // No media, no normalized image → falls back to collection_logo.
          { token_address: '0xCCC', token_id: '3', name: 'Coll C', collection_logo: 'http://logo/c' },
          // Missing token_id → skipped.
          { token_address: '0xDDD', token_id: '', name: 'Coll D' },
        ],
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider.getNftHoldings('0xWALLET', 'eth');
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(3);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://deep-index.test/api/v2.2/0xWALLET/nft?chain=0x1&format=decimal&normalizeMetadata=true&media_items=true');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('mk');

    expect(out![0]).toEqual({
      contractAddress: '0xaaa', // lowercased
      tokenId: '1',
      name: 'Alpha',
      description: 'first',
      collectionName: 'Coll A',
      logoUrl: 'http://cdn/high', // CDN media wins over the ipfs metadata image
      tokenStandard: 'ERC721',
      possibleSpam: false, // retrofit-73 (H13)
    });
    expect(out![1]!.logoUrl).toBe('https://ipfs.io/ipfs/bafyHash/img.png'); // ipfs:// rewritten
    expect(out![1]!.description).toBeNull();
    expect(out![2]!.logoUrl).toBe('http://logo/c'); // collection_logo last resort
  });

  it('non-ok HTTP → null (never throws); solana unsupported → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    expect(await provider.getNftHoldings('0xWALLET', 'eth')).toBeNull();
    expect(await provider.getNftHoldings('SoLaddr', 'solana')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GoldRush / Covalent
// ---------------------------------------------------------------------------

describe('GoldRushWalletProvider', () => {
  const provider = new GoldRushWalletProvider('cqt_key');

  it('scales raw balances by decimals, keeps native, drops unpriced dust, uses no-spam + Bearer auth', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            { contract_ticker_symbol: 'ETH', contract_name: 'Ether', contract_decimals: 18, contract_address: '0xeee', balance: '1500000000000000000', quote: 4500, quote_rate: 3000, native_token: true },
            { contract_ticker_symbol: 'USDC', contract_name: 'USD Coin', contract_decimals: 6, contract_address: '0xusdc', balance: '100000000', quote: 100, quote_rate: 1, native_token: false },
            { contract_ticker_symbol: 'JUNK', contract_decimals: 18, contract_address: '0xjunk', balance: '1000000000000000000', quote: null, quote_rate: null, native_token: false },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const r = await provider.getSummary('0xabc', 'eth');
    expect(r.status).toBe('ok');
    const s = r.summary!;
    expect(s.provider).toBe('goldrush');
    expect(s.nativeBalance).toBe(1.5);
    expect(s.tokens.map((t) => t.symbol)).toEqual(['ETH', 'USDC']);
    expect(s.tokens[1]!.balance).toBe(100);
    expect(s.totalUsd).toBe(4600);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/v1/eth-mainnet/address/0xabc/balances_v2/');
    expect(String(url)).toContain('no-spam=true');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cqt_key');
  });

  // retrofit-56: real on-chain tx count from transactions_summary (probe-confirmed shape).
  it('getTransactionCount reads data.items[0].total_count (transactions_summary, Bearer auth)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { items: [{ total_count: 420, latest_transaction: {} }] } }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    expect(await provider.getTransactionCount('0xabc', 'eth')).toBe(420);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/v1/eth-mainnet/address/0xabc/transactions_summary/');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cqt_key');
  });

  it('getTransactionCount → null on non-ok (e.g. 402 credit limit), missing total, or unmapped chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) }) as Response));
    expect(await provider.getTransactionCount('0xabc', 'eth')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { items: [{}] } }) }) as Response));
    expect(await provider.getTransactionCount('0xabc', 'eth')).toBeNull();
    expect(await provider.getTransactionCount('0xabc', 'polygon-zkevm')).toBeNull();
  });

  // retrofit-56: daily value history from portfolio_v2 — sum close.quote across tokens per day.
  it('getValueHistory sums close.quote across tokens per day, ascending; skips null quotes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            // Covalent returns holdings newest-first; we re-sort ascending.
            { contract_ticker_symbol: 'ETH', holdings: [
              { timestamp: '2026-06-19T08:00:00Z', close: { quote: 10 } },
              { timestamp: '2026-06-18T08:00:00Z', close: { quote: 8 } },
            ] },
            { contract_ticker_symbol: 'USDC', holdings: [
              { timestamp: '2026-06-19T08:00:00Z', close: { quote: 5 } },
              { timestamp: '2026-06-18T08:00:00Z', close: { quote: null } }, // null → skipped
            ] },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const vh = await provider.getValueHistory('0xabc', 'eth', 365);
    expect(vh).toEqual([
      { date: '2026-06-18', value: 8 }, // 8 + (null skipped)
      { date: '2026-06-19', value: 15 }, // 10 + 5
    ]);
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toContain('/v1/eth-mainnet/address/0xabc/portfolio_v2/');
    expect(String(url)).toContain('days=365');
  });

  it('getValueHistory → null on non-ok or empty items', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) }) as Response));
    expect(await provider.getValueHistory('0xabc', 'eth', 365)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { items: [] } }) }) as Response));
    expect(await provider.getValueHistory('0xabc', 'eth', 365)).toBeNull();
  });

  it('supportsChain false for unmapped chain (polygon-zkevm omitted)', () => {
    expect(provider.supportsChain('eth')).toBe(true);
    expect(provider.supportsChain('polygon-zkevm')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GoldRush / Covalent — transfer history + NFT holdings (retrofit-63)
// ---------------------------------------------------------------------------

describe('GoldRushWalletProvider — getTransferHistory (retrofit-63)', () => {
  const provider = new GoldRushWalletProvider('cqt_key');
  const WALLET = '0xcb1c1fde09f811b294172696404e88e658659905';

  it('maps native + erc20 + erc721 legs, filters non-wallet logs, gas on first leg, cursor = links.prev', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          links: {
            prev: 'https://api.covalenthq.com/v1/eth-mainnet/address/x/transactions_v3/page/3/',
            next: null,
          },
          items: [
            {
              block_signed_at: '2026-06-16T08:10:23Z',
              tx_hash: '0xhash1',
              from_address: WALLET,
              to_address: '0xrecipient',
              value: '5000000000000000000', // 5 ETH (raw wei)
              value_quote: 9000,
              fees_paid: '1000000000000000', // 0.001 ETH gas
              gas_metadata: { contract_decimals: 18, contract_ticker_symbol: 'ETH' },
              log_events: [
                {
                  // ERC-20 (3rd param `value`) incoming to the wallet
                  sender_address: '0xtoken',
                  sender_name: 'HEX',
                  sender_contract_ticker_symbol: 'HEX',
                  sender_contract_decimals: 8,
                  sender_logo_url: 'http://logo/hex',
                  decoded: {
                    name: 'Transfer',
                    params: [
                      { name: 'from', type: 'address', value: '0xother' },
                      { name: 'to', type: 'address', value: WALLET },
                      { name: 'value', type: 'uint256', value: '20000000000' }, // 200 HEX (8dp)
                    ],
                  },
                },
                {
                  // ERC-721 (3rd param `tokenId`) out of the wallet
                  sender_address: '0xnft',
                  sender_name: 'CoolCats',
                  sender_contract_ticker_symbol: null,
                  sender_contract_decimals: 0,
                  sender_logo_url: 'http://logo/nft',
                  decoded: {
                    name: 'Transfer',
                    params: [
                      { name: 'from', type: 'address', value: WALLET },
                      { name: 'to', type: 'address', value: '0xbuyer' },
                      { name: 'tokenId', type: 'uint256', value: '148' },
                    ],
                  },
                },
                {
                  // a Transfer between two OTHER addresses (pool routing) → must be dropped
                  sender_address: '0xpool',
                  sender_contract_ticker_symbol: 'WETH',
                  sender_contract_decimals: 18,
                  decoded: {
                    name: 'Transfer',
                    params: [
                      { name: 'from', type: 'address', value: '0xpoolA' },
                      { name: 'to', type: 'address', value: '0xpoolB' },
                      { name: 'value', type: 'uint256', value: '1000' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const page = await provider.getTransferHistory(WALLET, 'eth', { limit: 100 });
    expect(page).not.toBeNull();
    expect(page!.nextCursor).toContain('/transactions_v3/page/3/');
    expect(page!.totalCount).toBeNull();

    const t = page!.transfers;
    expect(t).toHaveLength(3); // native + erc20 + erc721 (pool-to-pool log dropped)

    const native = t.find((x) => x.type === 'native')!;
    expect(native.direction).toBe('out'); // from the wallet
    expect(native.symbol).toBe('ETH');
    expect(native.amount).toBeCloseTo(5, 9);
    expect(native.usdValue).toBe(9000);
    expect(native.gasFee).toBeCloseTo(0.001, 12); // gas attaches to the first leg only

    const erc20 = t.find((x) => x.type === 'erc20')!;
    expect(erc20.direction).toBe('in'); // to the wallet
    expect(erc20.symbol).toBe('HEX');
    expect(erc20.amount).toBe(200); // 20000000000 / 1e8
    expect(erc20.contractAddress).toBe('0xtoken');
    expect(erc20.usdValue).toBeNull();
    expect(erc20.gasFee).toBeNull(); // already taken by the native leg

    const nft = t.find((x) => x.type === 'nft')!;
    expect(nft.direction).toBe('out');
    expect(nft.nftTokenId).toBe('148');
    expect(nft.contractAddress).toBe('0xnft');
    expect(nft.gasFee).toBeNull();

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain(`/v1/eth-mainnet/address/${WALLET}/transactions_v3/`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cqt_key');
  });

  it('follows the cursor URL verbatim; solana + non-ok → null', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ data: { links: {}, items: [] } }) }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const cursorUrl =
      'https://api.covalenthq.com/v1/eth-mainnet/address/x/transactions_v3/page/3/';
    await provider.getTransferHistory(WALLET, 'eth', { cursor: cursorUrl });
    expect(String((fetchMock.mock.calls[0]! as [string])[0])).toBe(cursorUrl);

    expect(await provider.getTransferHistory(WALLET, 'solana', {})).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) }) as Response));
    expect(await provider.getTransferHistory(WALLET, 'eth', {})).toBeNull();
  });

  it('getNftHoldings maps nft_data with decimal tokenId, skips spam + zero-balance, no-spam URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          items: [
            {
              contract_name: 'Azuki',
              contract_address: '0xABC',
              supports_erc: ['erc20', 'erc165', 'erc721'],
              is_spam: false,
              nft_data: [
                {
                  token_id: '148',
                  token_balance: '1',
                  external_data: {
                    name: 'Azuki #148',
                    description: 'desc',
                    image: 'http://img/full',
                    image_512: 'http://img/512',
                  },
                },
                { token_id: '0', token_balance: '0' }, // zero balance → skipped
              ],
            },
            // spam collection → skipped entirely
            { contract_name: 'Spam', contract_address: '0xspam', is_spam: true, nft_data: [{ token_id: '1', token_balance: '1' }] },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider.getNftHoldings(WALLET, 'eth');
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(1);
    expect(out![0]).toEqual({
      contractAddress: '0xabc',
      tokenId: '148',
      name: 'Azuki #148',
      description: 'desc',
      collectionName: 'Azuki',
      logoUrl: 'http://img/512', // image_512 wins
      tokenStandard: 'ERC721',
      possibleSpam: false, // retrofit-73 (H13): GoldRush drops is_spam rows upstream
    });
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toContain('/balances_nft/');
    expect(String(url)).toContain('no-spam=true');
  });
});

// ---------------------------------------------------------------------------
// Alchemy (Portfolio Data API)
// ---------------------------------------------------------------------------

describe('AlchemyWalletProvider', () => {
  const provider = new AlchemyWalletProvider('al_key');

  it('decodes hex balances, prices via tokenPrices, treats null tokenAddress as native', async () => {
    const ethHex = '0x' + (1_500_000_000_000_000_000n).toString(16); // 1.5e18
    const usdcHex = '0x' + (100_000_000n).toString(16); // 100e6
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          tokens: [
            { tokenAddress: null, tokenBalance: ethHex, tokenMetadata: { symbol: 'ETH', decimals: 18, name: 'Ether' }, tokenPrices: [{ currency: 'usd', value: '3000' }] },
            { tokenAddress: '0xusdc', tokenBalance: usdcHex, tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin' }, tokenPrices: [{ currency: 'usd', value: '1' }] },
            { tokenAddress: '0xjunk', tokenBalance: usdcHex, tokenMetadata: { symbol: 'JUNK', decimals: 6 }, tokenPrices: [] },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const r = await provider.getSummary('0xabc', 'eth');
    expect(r.status).toBe('ok');
    const s = r.summary!;
    expect(s.provider).toBe('alchemy');
    expect(s.nativeSymbol).toBe('ETH');
    expect(s.nativeBalance).toBe(1.5);
    expect(s.tokens.find((t) => t.symbol === 'USDC')!.balance).toBe(100);
    expect(s.totalUsd).toBe(4600); // JUNK (unpriced non-native) dropped
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/data/v1/al_key/assets/tokens/by-address');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ addresses: [{ address: '0xabc', networks: ['eth-mainnet'] }] });
  });
});

describe('AlchemyWalletProvider — getTransferHistory + getNftHoldings (retrofit-63)', () => {
  const provider = new AlchemyWalletProvider('al_key');
  const WALLET = '0xcb1c1fde09f811b294172696404e88e658659905';

  it('queries from+to, merges/dedupes, maps native/erc20/erc721 (hex→decimal tokenId), packs both pageKeys', async () => {
    const fromResult = {
      result: {
        pageKey: 'PK_FROM',
        transfers: [
          { uniqueId: 'u1', blockNum: '0x20', hash: '0xh1', from: WALLET, to: '0xrecipient', value: 0.5, asset: 'ETH', category: 'external', rawContract: { address: null, decimal: '0x12' }, metadata: { blockTimestamp: '2026-06-16T08:10:23.000Z' } },
          { uniqueId: 'u2', blockNum: '0x20', hash: '0xh1', from: WALLET, to: '0x0', value: null, asset: null, category: 'erc721', tokenId: '0x94', rawContract: { address: '0xNFT' }, metadata: { blockTimestamp: '2026-06-16T08:10:23.000Z' } },
          { uniqueId: 'uShared', blockNum: '0x10', hash: '0xh0', from: WALLET, to: WALLET, value: 1, asset: 'USDC', category: 'erc20', rawContract: { address: '0xusdc' }, metadata: { blockTimestamp: '2026-06-15T00:00:00.000Z' } },
        ],
      },
    };
    const toResult = {
      result: {
        pageKey: null,
        transfers: [
          { uniqueId: 'u3', blockNum: '0x30', hash: '0xh3', from: '0xsender', to: WALLET, value: 250, asset: 'DAI', category: 'erc20', rawContract: { address: '0xdai' }, metadata: { blockTimestamp: '2026-06-17T00:00:00.000Z' } },
          { uniqueId: 'uShared', blockNum: '0x10', hash: '0xh0', from: WALLET, to: WALLET, value: 1, asset: 'USDC', category: 'erc20', rawContract: { address: '0xusdc' }, metadata: { blockTimestamp: '2026-06-15T00:00:00.000Z' } },
        ],
      },
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const p = JSON.parse(String(init!.body)).params[0];
      const isFrom = 'fromAddress' in p;
      return { ok: true, json: async () => (isFrom ? fromResult : toResult) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await provider.getTransferHistory(WALLET, 'eth', { limit: 100 });
    expect(page).not.toBeNull();
    expect(page!.transfers).toHaveLength(4); // 3 from + 2 to − 1 shared dupe

    const eth = page!.transfers.find((x) => x.symbol === 'ETH')!;
    expect(eth.type).toBe('native');
    expect(eth.direction).toBe('out');
    expect(eth.amount).toBe(0.5);
    expect(eth.contractAddress).toBeNull();
    expect(eth.gasFee).toBeNull();
    expect(eth.usdValue).toBeNull();

    const nft = page!.transfers.find((x) => x.type === 'nft')!;
    expect(nft.nftTokenId).toBe('148'); // 0x94 → 148 (hex→decimal)
    expect(nft.contractAddress).toBe('0xnft');

    const dai = page!.transfers.find((x) => x.symbol === 'DAI')!;
    expect(dai.direction).toBe('in');
    expect(dai.amount).toBe(250);

    expect(JSON.parse(page!.nextCursor!)).toEqual({ f: 'PK_FROM', t: null });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[0]! as [string])[0])).toBe('https://eth-mainnet.g.alchemy.com/v2/al_key');
  });

  it('continuation only re-queries directions that still have a pageKey; solana → null', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const p = JSON.parse(String(init!.body)).params[0];
      expect('fromAddress' in p).toBe(true); // only the FROM direction should be queried
      return { ok: true, json: async () => ({ result: { pageKey: null, transfers: [] } }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await provider.getTransferHistory(WALLET, 'eth', {
      cursor: JSON.stringify({ f: 'PK', t: null }),
    });
    expect(page!.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // TO had no key → not queried

    expect(await provider.getTransferHistory(WALLET, 'solana', {})).toBeNull();
  });

  it('getNftHoldings maps ownedNfts (decimal tokenId, cached-image precedence)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ownedNfts: [
          {
            contract: { address: '0xABC', name: 'Azuki', tokenType: 'ERC721' },
            tokenId: '148',
            tokenType: 'ERC721',
            name: 'Azuki #148',
            description: 'd',
            image: { cachedUrl: 'http://cdn/cached', pngUrl: 'http://cdn/png', originalUrl: 'http://orig' },
            collection: { name: 'AzukiColl' },
          },
          { contract: { address: '' }, tokenId: '1' }, // no contract → skipped
        ],
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider.getNftHoldings(WALLET, 'eth');
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(1);
    expect(out![0]).toEqual({
      contractAddress: '0xabc',
      tokenId: '148',
      name: 'Azuki #148',
      description: 'd',
      collectionName: 'Azuki',
      logoUrl: 'http://cdn/cached', // cachedUrl wins
      tokenStandard: 'ERC721',
      possibleSpam: false, // retrofit-73 (H13)
    });
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toContain('/nft/v3/al_key/getNFTsForOwner');
    expect(String(url)).toContain(`owner=${WALLET}`);
  });
});

// ---------------------------------------------------------------------------
// Ankr
// ---------------------------------------------------------------------------

describe('AnkrWalletProvider', () => {
  const provider = new AnkrWalletProvider('ankr_key');

  it('parses human balances + balanceUsd, classifies NATIVE, drops unpriced dust', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          assets: [
            { blockchain: 'eth', tokenName: 'Ether', tokenSymbol: 'ETH', tokenDecimals: 18, tokenType: 'NATIVE', balance: '1.5', balanceUsd: '4500', tokenPrice: '3000' },
            { blockchain: 'eth', tokenName: 'USD Coin', tokenSymbol: 'USDC', tokenDecimals: 6, tokenType: 'ERC20', contractAddress: '0xusdc', balance: '100', balanceUsd: '100', tokenPrice: '1' },
            { blockchain: 'eth', tokenSymbol: 'JUNK', tokenType: 'ERC20', contractAddress: '0xjunk', balance: '5', balanceUsd: null },
          ],
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const r = await provider.getSummary('0xabc', 'eth');
    expect(r.status).toBe('ok');
    const s = r.summary!;
    expect(s.provider).toBe('ankr');
    expect(s.nativeBalance).toBe(1.5);
    expect(s.tokens[0]!.isNative).toBe(true);
    expect(s.totalUsd).toBe(4600);

    const body = JSON.parse(String((fetchMock.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(body.method).toBe('ankr_getAccountBalance');
    expect(body.params).toMatchObject({ blockchain: 'eth', walletAddress: '0xabc', onlyWhitelisted: true });
  });

  it('JSON-RPC error envelope → status error', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ error: { code: -32000, message: 'bad' } }) }));
    expect((await provider.getSummary('0xabc', 'eth')).status).toBe('error');
  });

  it('does not support solana', () => {
    expect(provider.supportsChain('solana')).toBe(false);
    expect(provider.supportsChain('eth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — previewWallet / fetchWalletSummary with fake providers
// ---------------------------------------------------------------------------

function fakeProvider(
  name: string,
  // retrofit-60: `history` makes the fake also satisfy the Part-E light value-history check
  // (previewWallet now consults getValueHistory after a found summary). Omit it → no history →
  // previewWallet returns 'found_no_history'.
  opts: {
    configured?: boolean;
    supports?: boolean;
    result?: ProviderResult;
    history?: Array<{ date: string; value: number }>;
  },
): WalletDataProvider & { getSummary: ReturnType<typeof vi.fn> } {
  const getSummary = vi.fn(async () => opts.result ?? { status: 'error' });
  return {
    name,
    isConfigured: () => opts.configured ?? true,
    supportsChain: () => opts.supports ?? true,
    getSummary,
    ...(opts.history !== undefined ? { getValueHistory: vi.fn(async () => opts.history) } : {}),
  };
}

const SOME_HISTORY = [{ date: '2026-01-01', value: 100 }];

const okResult = (provider: string): ProviderResult => ({
  status: 'ok',
  summary: {
    nativeSymbol: 'ETH',
    nativeBalance: 1,
    totalUsd: 1000,
    tokenCount: 1,
    tokens: [{ symbol: 'ETH', name: 'Ether', contractAddress: null, balance: 1, decimals: 18, usdPrice: 1000, usdValue: 1000, isNative: true }],
    provider,
  },
});

describe('previewWallet orchestrator', () => {
  const ethChain = { slug: 'eth' };
  const VALID = '0xabcdef1234567890abcdef1234567890abcdef12';

  it('invalid address → invalid, no provider consulted', async () => {
    const p = fakeProvider('moralis', { result: okResult('moralis') });
    const out = await previewWallet('not-an-address', ethChain, [p]);
    expect(out.status).toBe('invalid');
    expect(p.getSummary).not.toHaveBeenCalled();
  });

  it('skips unconfigured + unsupported providers; first ok wins', async () => {
    const noKey = fakeProvider('moralis', { configured: false, result: okResult('moralis') });
    const unsupported = fakeProvider('goldrush', { supports: false, result: okResult('goldrush') });
    const winner = fakeProvider('alchemy', { result: okResult('alchemy'), history: SOME_HISTORY });
    const after = fakeProvider('ankr', { result: okResult('ankr') });

    const out = await previewWallet(VALID, ethChain, [noKey, unsupported, winner, after]);
    expect(out.status).toBe('found');
    expect(out.summary!.provider).toBe('alchemy');
    expect(noKey.getSummary).not.toHaveBeenCalled();
    expect(unsupported.getSummary).not.toHaveBeenCalled();
    expect(after.getSummary).not.toHaveBeenCalled(); // short-circuited after the win
  });

  it('falls through error → empty → ok in priority order', async () => {
    const errored = fakeProvider('moralis', { result: { status: 'error' } });
    const emptied = fakeProvider('goldrush', { result: { status: 'empty' } });
    const winner = fakeProvider('alchemy', { result: okResult('alchemy'), history: SOME_HISTORY });

    const out = await previewWallet(VALID, ethChain, [errored, emptied, winner]);
    expect(out.status).toBe('found');
    expect(out.summary!.provider).toBe('alchemy');
    expect(errored.getSummary).toHaveBeenCalledOnce();
    expect(emptied.getSummary).toHaveBeenCalledOnce();
  });

  // retrofit-60 Part E: a found summary but NO provider has value history → 'found_no_history'.
  it('found summary with no value-history provider → found_no_history (summary still returned)', async () => {
    const winner = fakeProvider('moralis', { result: okResult('moralis') }); // no history
    const out = await previewWallet(VALID, ethChain, [winner]);
    expect(out.status).toBe('found_no_history');
    expect(out.summary!.provider).toBe('moralis');
  });

  it('all empty/error → empty (well-formed address, add-anyway)', async () => {
    const a = fakeProvider('moralis', { result: { status: 'empty' } });
    const b = fakeProvider('goldrush', { result: { status: 'error' } });
    const out = await previewWallet(VALID, ethChain, [a, b]);
    expect(out.status).toBe('empty');
    expect(out.summary).toBeUndefined();
  });

  it('fetchWalletSummary returns the winning summary or null', async () => {
    const win = fakeProvider('moralis', { result: okResult('moralis') });
    expect((await fetchWalletSummary(VALID, ethChain, [win]))!.provider).toBe('moralis');

    const none = fakeProvider('moralis', { result: { status: 'empty' } });
    expect(await fetchWalletSummary(VALID, ethChain, [none])).toBeNull();
  });
});
