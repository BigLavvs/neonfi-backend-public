# retrofit-14: token-sync crash — null CMC price (defensive guard)

## Symptom (from a live `npm run dev` run)
```
[token-sync] provider fetch failed: TypeError: Cannot read properties of null (reading 'toFixed')
    at CoinMarketCapTokenMetadataProvider.fetchMetadata (src/modules/tokens/sync/coinmarketcap-provider.ts:96)
[token-sync] complete vendor=coinmarketcap updated=0 skipped=0 failed=30 duration=5287ms
```
The 6-hourly token metadata cron crashes for the **whole batch** (`failed=30`) the moment CMC
returns a `null` `price` for any one symbol.

## Root cause
`src/modules/tokens/sync/coinmarketcap-provider.ts`:
- **Line 96** (`fetchMetadata`): `currentPrice: usd.price.toFixed(8)` — unguarded. `market_cap` on
  the next line IS guarded (`usd.market_cap != null ? … : null`), but `price` is not, so a null
  `price` throws and the exception propagates out of the loop, failing the entire run.
- **Line 125** (`fetchPrices`): `out.set(symbol, { price: usd.price, change24h: … })` — passes a
  possibly-null `price` straight into `PriceData` (typed `number`), which will surface as a bad
  value / downstream error rather than a crash.

## Fix (defensive — don't let one bad symbol sink the batch)
In `fetchMetadata`, after `const usd = entry.quote.USD;` (line ~93), skip symbols with no usable
price so the rest still update:
```ts
const usd = entry.quote.USD;
if (usd?.price == null) continue; // CMC returned no price for this symbol — skip, don't crash the batch
out.set(symbol, {
  symbol,
  currentPrice: usd.price.toFixed(8),
  marketCap: usd.market_cap != null ? usd.market_cap.toFixed(2) : null,
  rank: entry.cmc_rank ?? null,
});
```
In `fetchPrices` (line ~118-126), apply the same guard so null prices are skipped rather than
emitted:
```ts
const usd = entry.quote.USD;
if (usd?.price == null) continue;
out.set(symbol, { price: usd.price, change24h: usd.percent_change_24h });
```
This makes a run report `updated=N skipped=M failed=0` instead of crashing. Existing seeded
DB prices are retained for skipped tokens (the app keeps working — that's why the frontend still
shows e.g. BTC $93,000 today).

## Also flag (config, NOT fixed here — needs Idowu)
Every one of the 30 symbols came back with a null price, which points at the **CMC credential /
plan**, not just the missing guard: a sandbox key, an unentitled endpoint, or symbols the keyed
plan doesn't cover all return null `quote.USD.price`. After this guard lands, a run will likely
show `updated=0 skipped=30` — green, but still not refreshing prices. Verify `CMC_API_KEY` and the
plan/endpoint (and that the symbols are covered) so prices actually update. (Separately: token
`logoUrl` is null across the board, so the frontend shows letter-avatar fallbacks — logo
backfill is the metadata sync's job and will start working once real metadata flows.)

## Gates
- Add/extend the provider unit test (e.g. `tests/token-sync.test.ts` or a provider-level test):
  a CMC response where one symbol has `quote.USD.price = null` → `fetchMetadata` returns the OTHER
  symbols and does NOT throw; the null-price symbol is absent from the result Map. Same for
  `fetchPrices`.
- Run the token-sync test file + a couple of unrelated files (Neon-retry recipe). Confirm the
  moralis-webhook signature tests still pass.

## Commit (explicit add, no -A)
```bash
git add src/modules/tokens/sync/coinmarketcap-provider.ts tests/token-sync.test.ts _claude/retrofit-14.md
git commit -m "fix(token-sync): guard null CMC price so one bad symbol can't crash the batch (retrofit-14)"
```
Leave stale `_claude/stage-14*.md` / `frontend-audit.md` untracked. Report the SHA + test results.
```
