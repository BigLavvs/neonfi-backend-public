# retrofit-39 — Expose a 24h market change per asset (so the wallet badge is never a bare dash)

## Symptom
The wallet token badge shows each token's 24h change, overlaid live from the price firehose. But a
token only gets a value once the firehose has streamed a tick for it this session — so a covered coin
like ADA can sit on a neutral "—" (and looked green before the FE neutral-badge fix) just because it
hasn't ticked yet, while BTC/ETH (which ticked) show their %. The badge has no on-load source of 24h
change. The frontend now reads `asset.priceChange24h` as the badge default (falls back to "—"); this
retrofit provides that field.

## Part A (core, no schema change) — asset DTO `priceChange24h` from the live cache
The resolver already writes the canonical tick as `price:<SYMBOL> = {price, change24h, source, ts}`
(60s TTL). `lib/live-price.ts` reads only the price. Add the change alongside it and surface it on the
per-asset DTO:

1. `src/lib/live-price.ts`: add a sibling to `getLivePriceMap` that returns the 24h change too —
   e.g. `getLiveChangeMap(symbols): Promise<Map<string, number>>` (parse `change24h` from the same
   `price:<SYM>` payloads; omit misses). Or widen the existing map to `{ price, change24h }`.
2. Wherever the per-asset DTO is built for `GET /portfolios/:id/assets` (the same place that sets
   `price`/`value`/`costTracked` — `src/modules/assets/assets.service.ts` + `assets.dto.ts`): read the
   live change map for the portfolio's symbols and set `priceChange24h: liveChange.get(sym) ?? null`.
3. DTO/schema types: add `priceChange24h: number | null` to the asset DTO shape.

Result: any token with a warm cache entry (i.e. that has ticked within 60s — true for majors like ADA
when the feed is healthy) carries its 24h change on load, so the badge shows immediately. The firehose
overlay (frontend) still updates it live after.

## Part B (robustness, optional) — persist `Token.change24h` from CMC as a cold-cache fallback
So even a token that hasn't ticked recently (cold cache) still shows a (slightly stale) 24h change:

1. `prisma/schema.prisma`: add `change24h Decimal? @db.Decimal(10, 4)` to `Token`; migrate.
2. CMC already returns `percent_change_24h`:
   - `coinmarketcap-provider.ts` `fetchMetadata` → include `change24h` in `TokenMetadata` (read
     `entry.quote.USD.percent_change_24h`); the 6-hourly sync writes it.
   - `fetchTopTokens` → add `change24h` to `TopToken` from `quote.USD.percent_change_24h`; the catalog
     ingest writes it on create/update.
3. Asset DTO: `priceChange24h = liveChange.get(sym) ?? Number(token.change24h) ?? null` — live cache
   first (freshest), CMC-persisted value as fallback, null only when truly unknown.

## Tests
- `priceChange24h` present when the symbol has a fresh `price:<SYM>` cache entry; equals the cached
  `change24h`; falls back to the persisted `Token.change24h` (Part B) when the cache is cold; `null`
  when neither exists.
- `tsc --noEmit` clean; assets/derive + provider suites green; `NODE_ENV=test`, dev stopped.

## Commit
Named files only: `src/lib/live-price.ts`, `src/modules/assets/assets.service.ts`,
`src/modules/assets/assets.dto.ts` (+ Part B: `prisma/schema.prisma`, the migration,
`coinmarketcap-provider.ts`, `sync.ts`, `catalog-ingest.ts`), and tests. Report SHA. Leave dev stopped.

## After it lands
Open the wallet: every covered token (ADA included) shows its 24h change on load — green/red by sign,
neutral "—" only for a token with genuinely no 24h data anywhere.
