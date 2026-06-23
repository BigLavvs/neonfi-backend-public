# retrofit-40 — Repair token records: dedupe symbol collisions by rank + backfill logos

## Symptom (confirmed live via GET /tokens)
- `DOGE` → `logoUrl: https://s2.coinmarketcap.com/static/img/coins/64x64/74.png` (renders fine).
- `TON` → `{ name: "Toncoin", rank: 3538, logoUrl: null }`. Rank 3538 is wrong — real Toncoin is a
  top-15 coin. So the catalog's "TON" row is a *different/junk* coin that uses the same ticker, and
  it has no logo. That's why TON shows a broken/wrong icon while DOGE is fine. (The flicker itself is
  fixed separately in the frontend — `TokenIcon` now memoises the resolved source so re-renders don't
  replay the fallback chain.)

## Root cause
CMC reuses tickers across coins, so `quotes/latest?symbol=TON` and `listings/latest` both return
MULTIPLE "TON" entries. Both ingest paths dedupe by **highest market cap**:

- `fetchTopTokens` (catalog ingest): `if (prev && prev._mc >= mc) continue;`
- `fetchMetadata` (6-hourly sync): `entries.reduce((best, cur) => (cur.quote.USD.market_cap ?? 0) > (best...market_cap ?? 0) ? cur : best)`

When the canonical coin's `market_cap` is null/absent in the response (a common CMC data gap) its cap
counts as 0, so a junk coin with any non-null cap WINS — picking rank-3538 "TON" over real Toncoin.
`cmc_rank` is the authoritative prominence signal and is far more reliably populated, so dedupe should
prefer the **lowest cmc_rank**, with market cap only as a tiebreak.

## Changes — `src/modules/tokens/sync/coinmarketcap-provider.ts`
### 1. Capture the CMC `id` (needed to build the logo URL on the sync path)
- `CmcEntry` (quotes/latest shape): add `id: number`. `CmcListing` already has `id`.

### 2. Dedupe by lowest `cmc_rank`, then highest market cap — BOTH paths
`fetchTopTokens` loop:
```ts
const rank = c.cmc_rank ?? Number.MAX_SAFE_INTEGER;
const prev = best.get(c.symbol);
if (prev) {
  const prevRank = prev._rank ?? Number.MAX_SAFE_INTEGER;
  // keep the more prominent coin: lower cmc_rank wins; tie → higher market cap
  if (prevRank < rank || (prevRank === rank && prev._mc >= mc)) continue;
}
best.set(c.symbol, { …, _mc: mc, _rank: rank });   // add _rank alongside _mc; strip both in the final map()
```
`fetchMetadata` reducer:
```ts
const entry = entries.reduce((best, cur) => {
  const br = best.cmc_rank ?? Number.MAX_SAFE_INTEGER;
  const cr = cur.cmc_rank ?? Number.MAX_SAFE_INTEGER;
  if (cr !== br) return cr < br ? cur : best;
  return (cur.quote.USD.market_cap ?? 0) > (best.quote.USD.market_cap ?? 0) ? cur : best;
});
```

### 3. `fetchMetadata` returns a logoUrl from the chosen entry's id
```ts
out.set(symbol, {
  symbol,
  currentPrice: usd.price.toFixed(8),
  marketCap: usd.market_cap != null ? usd.market_cap.toFixed(2) : null,
  rank: entry.cmc_rank ?? null,
  change24h: usd.percent_change_24h ?? null,           // retrofit-39
  logoUrl: `https://s2.coinmarketcap.com/static/img/coins/64x64/${entry.id}.png`, // retrofit-40
});
```

## Changes — `src/modules/tokens/sync/provider.ts`
Add `logoUrl?: string | null` to `TokenMetadata`.

## Changes — `src/modules/tokens/sync/sync.ts`
Write the logo on the metadata sync so the 6-hourly job REPAIRS stale/null logos (set when present;
never null out a good one):
```ts
...(meta.logoUrl ? { logoUrl: meta.logoUrl } : {}),
```
(The ingest path already writes `logoUrl` on create/update.)

## Tests (`tests/token-sync.test.ts`, `tests/token-catalog-ingest.test.ts`)
- Dedupe: given two same-ticker entries where the LOWER-rank coin has `market_cap: null` and the
  higher-rank junk coin has a non-null cap, both `fetchMetadata` and `fetchTopTokens` keep the
  lower-rank (canonical) coin — i.e. real Toncoin (rank ~15) over rank-3538 "TON".
- `fetchMetadata` now returns `logoUrl` built from the chosen entry's `id`.
- sync writes `logoUrl` (set when provided; a later sync that omits it doesn't null the prior).
- `tsc --noEmit` clean; token-sync + token-catalog-ingest suites green; `NODE_ENV=test`, dev stopped.

## Commit & run
Commit named files only (`coinmarketcap-provider.ts`, `provider.ts`, `sync.ts`, the test files);
report SHA. Then repair the live catalog: **`npm run seed:tokens`** (the ingest, now deduping by
rank) — re-resolves "TON" to real Toncoin (rank ~15) and writes its CMC logo. Paste the
`token_catalog_ingest` line. Leave dev stopped.

## After it lands
`GET /tokens?search=TON` → `rank` ~15 and a non-null `s2.coinmarketcap.com` logoUrl; the picker shows
the real Toncoin diamond (and, with the frontend memo, no flicker). Spot-check a few other tickers
prone to collisions (e.g. UNI, APT, SUI) resolve to their canonical coin.
