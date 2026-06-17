// Neonfi backend — token catalog ingest tests (retrofit-34).
//
// fetchTopTokens parsing is pure (stubbed global fetch). runTokenCatalogIngest is tested
// with an injected fake TopTokenProvider + a MOCKED prisma, so no real CMC/Neon calls
// happen (unlike token-sync.test.ts, which exercises runTokenMetadataSync against the
// real DB). prisma.token.{findUnique,upsert} are the only surfaces this routine touches.

import { it, expect, describe, vi, beforeEach } from 'vitest';

const { tokenFindUnique, tokenUpsert } = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  tokenUpsert: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { token: { findUnique: tokenFindUnique, upsert: tokenUpsert } },
}));

import { CoinMarketCapTokenMetadataProvider } from '../src/modules/tokens/sync/coinmarketcap-provider.js';
import { runTokenCatalogIngest, type TopTokenProvider } from '../src/modules/tokens/sync/catalog-ingest.js';

// ---------------------------------------------------------------------------
// fetchTopTokens (CMC listings) parsing — stubbed fetch
// ---------------------------------------------------------------------------

describe('fetchTopTokens (CMC listings) parsing', () => {
  it('dedupes by symbol keeping the highest market cap; builds logoUrl from id; skips null prices', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 1,    name: 'Bitcoin',  symbol: 'BTC',  cmc_rank: 1,    quote: { USD: { price: 90000, market_cap: 1_800_000_000_000, percent_change_24h: 2.5 } } },
          // duplicate BTC ticker with a SMALLER market cap → must be ignored
          { id: 9001, name: 'BitcoinX', symbol: 'BTC',  cmc_rank: 999,  quote: { USD: { price: 5,     market_cap: 1_000, percent_change_24h: -9 } } },
          { id: 1027, name: 'Ethereum', symbol: 'ETH',  cmc_rank: 2,    quote: { USD: { price: 3000,  market_cap: 360_000_000_000, percent_change_24h: -1.2 } } },
          // null price → skipped entirely
          { id: 5,    name: 'NullCoin', symbol: 'NULL', cmc_rank: null, quote: { USD: { price: null,  market_cap: null, percent_change_24h: 0 } } },
        ],
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const provider = new CoinMarketCapTokenMetadataProvider('test-key');
      const top = await provider.fetchTopTokens(100);

      const bySym = new Map(top.map((t) => [t.symbol, t]));
      expect(top).toHaveLength(2); // BTC + ETH only
      expect(bySym.has('NULL')).toBe(false);

      // BTC kept the high-market-cap listing (id 1, name Bitcoin), not the dup (id 9001).
      const btc = bySym.get('BTC')!;
      expect(btc.name).toBe('Bitcoin');
      expect(btc.currentPrice).toBe('90000.00000000');
      expect(btc.marketCap).toBe('1800000000000.00');
      expect(btc.rank).toBe(1);
      expect(btc.logoUrl).toBe('https://s2.coinmarketcap.com/static/img/coins/64x64/1.png');
      expect(btc.change24h).toBe(2.5); // retrofit-39: percent_change_24h flows into TopToken
      expect(bySym.get('ETH')!.change24h).toBe(-1.2);

      // Request is shaped as a market-cap-ranked listings call carrying the limit.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0]![0]);
      expect(url).toContain('/v1/cryptocurrency/listings/latest');
      expect(url).toContain('limit=100');
      expect(url).toContain('sort=market_cap');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns [] and does not fetch when no API key is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new CoinMarketCapTokenMetadataProvider(undefined);
      const top = await provider.fetchTopTokens(50);
      expect(top).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// runTokenCatalogIngest — injected provider + mocked prisma
// ---------------------------------------------------------------------------

describe('runTokenCatalogIngest', () => {
  beforeEach(() => {
    tokenFindUnique.mockReset();
    tokenUpsert.mockReset();
    tokenUpsert.mockResolvedValue({});
  });

  it('inserts new symbols and updates existing ones (2 new + 1 existing → inserted=2, updated=1)', async () => {
    // AAA + BBB are new (findUnique → null); CCC already exists (findUnique → {id}).
    tokenFindUnique.mockImplementation(async ({ where }: { where: { symbol: string } }) =>
      (where.symbol === 'CCC' ? { id: 42 } : null),
    );

    const fakeProvider: TopTokenProvider = {
      fetchTopTokens: async () => [
        { symbol: 'AAA', name: 'Alpha', rank: 10, currentPrice: '1.00000000', marketCap: '100.00', logoUrl: 'http://x/1.png', change24h: 3.3 },
        { symbol: 'BBB', name: 'Beta',  rank: 11, currentPrice: '2.00000000', marketCap: '200.00', logoUrl: null,            change24h: null },
        { symbol: 'CCC', name: 'Gamma', rank: 12, currentPrice: '3.00000000', marketCap: null,     logoUrl: 'http://x/3.png', change24h: -4.4 },
      ],
    };

    const result = await runTokenCatalogIngest(3, fakeProvider);

    expect(result).toEqual({ inserted: 2, updated: 1 });
    expect(tokenUpsert).toHaveBeenCalledTimes(3);

    // AAA (new): create carries the retrofit-39 change24h.
    const aaaCall = tokenUpsert.mock.calls.find((c) => c[0].where.symbol === 'AAA')![0];
    expect(aaaCall.create.change24h).toBe(3.3);

    // BBB (new, null logo + null change): create carries logoUrl:null AND change24h:null;
    // update OMITS logoUrl (null not written) but keeps rank (provided).
    const bbbCall = tokenUpsert.mock.calls.find((c) => c[0].where.symbol === 'BBB')![0];
    expect(bbbCall.create).toMatchObject({ symbol: 'BBB', name: 'Beta', currentPrice: '2.00000000', logoUrl: null, change24h: null });
    expect(bbbCall.update.logoUrl).toBeUndefined();
    expect(bbbCall.update.change24h).toBeUndefined(); // null change must not null out the prior on update
    expect(bbbCall.update.rank).toBe(11);

    // CCC (existing, null marketCap): update keeps the truthy logoUrl + rank, writes marketCap
    // null, and refreshes change24h with the provided value (retrofit-39).
    const cccCall = tokenUpsert.mock.calls.find((c) => c[0].where.symbol === 'CCC')![0];
    expect(cccCall.update).toMatchObject({
      name: 'Gamma',
      currentPrice: '3.00000000',
      marketCap: null,
      logoUrl: 'http://x/3.png',
      rank: 12,
      change24h: -4.4,
    });
  });

  it('handles an empty top list — no upserts, zero counts', async () => {
    const fakeProvider: TopTokenProvider = { fetchTopTokens: async () => [] };
    const result = await runTokenCatalogIngest(10, fakeProvider);
    expect(result).toEqual({ inserted: 0, updated: 0 });
    expect(tokenUpsert).not.toHaveBeenCalled();
  });
});
