# retrofit-53 — DIAGNOSTIC ONLY (no app code changes)

NFT images + descriptions still show blank even on a freshly-created connected portfolio. Every code
layer has been verified correct: `getNftHoldings` requests with `normalizeMetadata=true&media_items=true`
(moralis.ts:380), `importNftHoldings` writes `logoUrl`/`description` (sync.ts), the `Nft` row, the DTO
(nfts.dto.ts), the repo (no restrictive `select`), and the frontend modal all carry them. So the value
is null *before* it reaches the UI. This script finds exactly where. **Change NO app code. Read-only.
Delete the temp script when done.**

## Step 1 — what's actually stored
Pick the connected portfolio you just created and dump its NFT rows:
```sql
SELECT id, name, "walletAddress", "chainId" FROM "portfolio" WHERE type='connected' AND "walletAddress" IS NOT NULL ORDER BY id DESC LIMIT 5;
-- then, with the portfolio id from above:
SELECT name, "contractAddress", LEFT("tokenId", 20) AS token_id, "logoUrl", LEFT(description, 60) AS descr FROM "nft" WHERE "portfolioId" = <ID> LIMIT 10;
```
Note whether `logoUrl` / `description` are NULL or populated in the DB, and grab the `walletAddress` +
`chainId`.

## Step 2 — what Moralis actually returns
Resolve the chain slug → Moralis hex (eth=`0x1`, polygon=`0x89`, base=`0x2105`, arbitrum=`0xa4b1`,
optimism=`0xa`, bnb=`0x38`, avalanche=`0xa86a`). Write a temp `scripts/diag-nfts.mjs` and run it
against the wallet from Step 1. Env: `MORALIS_API_KEY`; base default
`https://deep-index.moralis.io/api/v2.2` (`MORALIS_DEEP_INDEX_BASE`). Load env the way the project
does (it's `tsx`/dotenv — e.g. `node -r dotenv/config scripts/diag-nfts.mjs <addr> <hex>`).

```js
const KEY = process.env.MORALIS_API_KEY;
const BASE = process.env.MORALIS_DEEP_INDEX_BASE || 'https://deep-index.moralis.io/api/v2.2';
const ADDR = process.argv[2];
const CHAIN = process.argv[3] || '0x1';
const url = `${BASE}/wallets/${ADDR}/nfts?chain=${CHAIN}&normalizeMetadata=true&media_items=true&limit=10`;
const res = await fetch(url, { headers: { 'X-API-Key': KEY, accept: 'application/json' } });
console.log('HTTP', res.status, url.replace(KEY, ''));
const json = await res.json();
const items = json.result ?? [];
console.log('count', items.length);
for (const it of items) {
  console.log('---');
  console.log('name           ', it.name);
  console.log('contract       ', it.token_address);
  console.log('token_id       ', String(it.token_id).slice(0, 22));
  console.log('possible_spam  ', it.possible_spam);
  console.log('has norm_meta? ', !!it.normalized_metadata);
  console.log('norm.image     ', it.normalized_metadata?.image ?? '(none)');
  console.log('norm.descr     ', (it.normalized_metadata?.description ?? '(none)').slice(0, 80));
  console.log('has media?     ', !!it.media);
  console.log('media url      ', it.media?.media_collection?.high?.url ?? it.media?.original_media_url ?? '(none)');
  console.log('collection_logo', it.collection_logo ?? '(none)');
}
console.log('=== RAW first item (every field Moralis returns) ===');
console.log(JSON.stringify(items[0], null, 2));
```

## Step 3 — paste both outputs back
The Step-1 DB dump + the Step-2 Moralis dump together tell us exactly which is true:
- **DB null + Moralis returns image/descr** → the running backend is serving stale code (the
  param/precedence from retrofit-52 isn't live). Fix = restart the backend dev server so it picks up
  the committed code, then resync.
- **DB null + Moralis also returns no image/descr (and `possible_spam: true`)** → these NFTs simply
  have no metadata at Moralis (spam airdrops). Not a bug; we'd need a different image source or just
  accept the placeholder for spam. Test a real NFT (an ENS `.eth` name) to confirm real ones work.
- **DB populated + UI blank** → frontend/DTO mismatch after all; paste the DB row + the NFT DTO JSON
  from `GET /portfolios/<id>/nfts` and I'll fix the exact field.

Then I fix to whatever the output shows — no more inference.

## Out of scope
No schema changes, no app-code changes, no commit. Pure read-only triage. Remove `scripts/diag-nfts.mjs` after.
