// retrofit-34 — ingest a real token catalog (CMC top-N) into the Token table.
//
// Distinct from runTokenMetadataSync (sync.ts): that path reads the EXISTING rows and
// only UPDATEs their price/marketCap/rank — it never INSERTs, so the universe was frozen
// at the ~30 seeded rows. This routine UPSERTs the CMC top-N by market cap, so search and
// cursor pagination get real content. Realtime still only covers exchange-listed symbols
// (Coinbase/Kraken); the rest show the CMC price refreshed by the 6-hourly sync.

import { prisma } from '../../../lib/prisma.js';
import { config } from '../../../lib/config.js';
import { CoinMarketCapTokenMetadataProvider, type TopToken } from './coinmarketcap-provider.js';

// Minimal provider surface this routine needs. Kept separate from TokenMetadataProvider so
// the existing sync mocks don't have to grow a method, and tests can inject a tiny fake.
export interface TopTokenProvider {
  fetchTopTokens(limit: number): Promise<TopToken[]>;
}

let _defaultProvider: TopTokenProvider | null = null;

// Mirrors sync.ts's lazy getDefaultProvider — same CMC adapter + API key from config.
function getDefaultProvider(): TopTokenProvider {
  if (!_defaultProvider) {
    _defaultProvider = new CoinMarketCapTokenMetadataProvider(config.COINMARKETCAP_API_KEY);
  }
  return _defaultProvider;
}

export async function runTokenCatalogIngest(
  limit: number,
  provider?: TopTokenProvider,
): Promise<{ inserted: number; updated: number }> {
  const p = provider ?? getDefaultProvider();
  const top = await p.fetchTopTokens(limit);

  let inserted = 0;
  let updated = 0;
  for (const t of top) {
    const existing = await prisma.token.findUnique({
      where: { symbol: t.symbol },
      select: { id: true },
    });
    await prisma.token.upsert({
      where: { symbol: t.symbol },
      create: {
        symbol: t.symbol,
        name: t.name,
        currentPrice: t.currentPrice,
        marketCap: t.marketCap,
        rank: t.rank,
        logoUrl: t.logoUrl,
      },
      // Don't overwrite an existing logoUrl with null, and keep rank only when provided.
      update: {
        name: t.name,
        currentPrice: t.currentPrice,
        marketCap: t.marketCap,
        ...(t.rank != null ? { rank: t.rank } : {}),
        ...(t.logoUrl ? { logoUrl: t.logoUrl } : {}),
      },
    });
    if (existing) updated++;
    else inserted++;
  }

  console.log(JSON.stringify({
    event: 'token_catalog_ingest',
    requested: limit,
    got: top.length,
    inserted,
    updated,
  }));
  return { inserted, updated };
}
