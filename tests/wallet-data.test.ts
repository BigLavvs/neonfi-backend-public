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

  it('supportsChain false for unmapped chain (polygon-zkevm omitted)', () => {
    expect(provider.supportsChain('eth')).toBe(true);
    expect(provider.supportsChain('polygon-zkevm')).toBe(false);
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
  opts: { configured?: boolean; supports?: boolean; result?: ProviderResult },
): WalletDataProvider & { getSummary: ReturnType<typeof vi.fn> } {
  const getSummary = vi.fn(async () => opts.result ?? { status: 'error' });
  return {
    name,
    isConfigured: () => opts.configured ?? true,
    supportsChain: () => opts.supports ?? true,
    getSummary,
  };
}

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
    const winner = fakeProvider('alchemy', { result: okResult('alchemy') });
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
    const winner = fakeProvider('alchemy', { result: okResult('alchemy') });

    const out = await previewWallet(VALID, ethChain, [errored, emptied, winner]);
    expect(out.status).toBe('found');
    expect(out.summary!.provider).toBe('alchemy');
    expect(errored.getSummary).toHaveBeenCalledOnce();
    expect(emptied.getSummary).toHaveBeenCalledOnce();
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
