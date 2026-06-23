# retrofit-34 — Ingest a real token catalog (CMC top-N), not 30 seeded rows

## Why
The Token table holds only **30 tokens** (`/tokens?limit=50` → 30, nextCursor null). The picker and
search are therefore tiny, and `runTokenMetadataSync` can't help — it reads the *existing* rows and
only UPDATES price/marketCap/rank; it never INSERTS. So the universe is frozen at whatever was seeded.
We need an ingestion path that INSERTS the CMC top-N so search/pagination have real content. (The
frontend now does cursor infinite-scroll, so a bigger catalog is immediately browsable.)

## Changes

### 1. `src/modules/tokens/sync/coinmarketcap-provider.ts` — add `fetchTopTokens`
Add a method using CMC **listings** (ranked by market cap), separate from the existing symbol-native
`quotes/latest`:
```ts
const CMC_LISTINGS_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';

export interface TopToken { symbol: string; name: string; rank: number | null; currentPrice: string; marketCap: string | null; logoUrl: string | null; }

async fetchTopTokens(limit: number): Promise<TopToken[]> {
  if (!this.apiKey) { console.warn('[cmc-provider] no API key — skipping fetchTopTokens'); return []; }
  const url = `${CMC_LISTINGS_URL}?start=1&limit=${limit}&convert=USD&sort=market_cap`;
  const res = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': this.apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CMC listings HTTP ${res.status}: ${await res.text().catch(()=> '')}`);
  const body = await res.json() as { data: Array<{ id:number; name:string; symbol:string; cmc_rank:number|null; quote:{USD:{price:number|null; market_cap:number|null}} }> };
  // Dedupe by symbol (CMC has duplicate tickers) — keep the highest market cap. logoUrl from the
  // public CMC static CDN keyed by coin id.
  const best = new Map<string, TopToken & { _mc: number }>();
  for (const c of body.data ?? []) {
    const usd = c.quote?.USD; if (!usd || usd.price == null) continue;
    const mc = usd.market_cap ?? 0;
    const prev = best.get(c.symbol);
    if (prev && prev._mc >= mc) continue;
    best.set(c.symbol, {
      symbol: c.symbol, name: c.name, rank: c.cmc_rank ?? null,
      currentPrice: usd.price.toFixed(8),
      marketCap: usd.market_cap != null ? usd.market_cap.toFixed(2) : null,
      logoUrl: `https://s2.coinmarketcap.com/static/img/coins/64x64/${c.id}.png`,
      _mc: mc,
    });
  }
  return [...best.values()].map(({ _mc, ...t }) => t);
}
```

### 2. New ingestion routine — `src/modules/tokens/sync/catalog-ingest.ts`
```ts
export async function runTokenCatalogIngest(limit: number, provider?): Promise<{ inserted:number; updated:number }> {
  const p = provider ?? getDefaultProvider(); // reuse the same lazy provider as sync.ts
  const top = await p.fetchTopTokens(limit);
  let inserted = 0, updated = 0;
  for (const t of top) {
    const existing = await prisma.token.findUnique({ where: { symbol: t.symbol }, select: { id: true } });
    await prisma.token.upsert({
      where: { symbol: t.symbol },
      create: { symbol: t.symbol, name: t.name, currentPrice: t.currentPrice, marketCap: t.marketCap, rank: t.rank, logoUrl: t.logoUrl },
      // don't overwrite an existing logoUrl with null; keep rank fresh
      update: { name: t.name, currentPrice: t.currentPrice, marketCap: t.marketCap, ...(t.rank!=null?{rank:t.rank}:{}), ...(t.logoUrl?{logoUrl:t.logoUrl}:{}) },
    });
    existing ? updated++ : inserted++;
  }
  console.log(JSON.stringify({ event:'token_catalog_ingest', requested: limit, got: top.length, inserted, updated }));
  return { inserted, updated };
}
```
Check the exact `Token` columns in `prisma/schema.prisma` first and match them (name, symbol unique,
currentPrice/marketCap Decimal, rank Int?, logoUrl String?). If there are other NOT NULL columns
without defaults, supply sensible values in `create`.

### 3. Runnable entry — `package.json` script + optional env
- Add `src/scripts/seed-catalog.ts` (a tiny `tsx` entry) that calls `runTokenCatalogIngest(Number(process.env.TOKEN_CATALOG_SIZE ?? 500))` then `process.exit(0)`.
- Add `"seed:tokens": "tsx src/scripts/seed-catalog.ts"` to package.json scripts.
- (Optional, your call) also call `runTokenCatalogIngest` once at boot in `startPriceFeeds` BEFORE
  `loadCatalogSymbols()` when `TOKEN_CATALOG_AUTO_INGEST=true` (default false), so prod can self-seed.
  Keep it off by default so dev boots stay fast.

## Tests
- Unit-test `fetchTopTokens` parsing with a stubbed `fetch` (dedupe-by-symbol keeps highest market
  cap; logoUrl built from id; null-price entries skipped).
- Unit-test `runTokenCatalogIngest` with a fake provider returning 2 new + 1 existing symbol → assert
  upsert calls / inserted=2,updated=1 (mock prisma like the existing sync tests do).
- `tsc --noEmit` + the new + token-sync suites green, `NODE_ENV=test`. Commit named files (provider,
  catalog-ingest.ts, the script, package.json, tests) — no `-A`. Report SHA. Leave dev stopped.

## After it lands
Run `npm run seed:tokens` once (needs `COINMARKETCAP_API_KEY`). Then `/tokens?limit=50` should page
through hundreds, the Add Asset picker scrolls the full list, and search finds any ingested coin.
Realtime still only covers exchange-listed symbols (Coinbase/Kraken); the rest show the CMC price
refreshed by the 6-hourly sync — which now covers all ingested tokens.
