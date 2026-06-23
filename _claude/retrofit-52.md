# retrofit-52 — Make NFT image + description actually populate (Moralis normalizeMetadata)

## Why this is needed
retrofit-51 wired `Nft.description` end-to-end, but it — and the NFT **image** — still come up
empty in the UI (placeholder hexagon, no description). Root cause: the Moralis holdings request
omits `normalizeMetadata`. Moralis only returns the `normalized_metadata` object when
`normalizeMetadata=true` is passed; without it the field is absent, so
`it.normalized_metadata?.image` and `?.description` are **always `undefined`**. This has been true
since retrofit-49 — the image never populated either. retrofit-51 added a column fed by a value that
is never set. This retrofit fixes the source.

## 1. Fix the request URL
`src/modules/wallet-data/providers/moralis.ts`, `getNftHoldings` (~line 355):
```ts
const url = `${this.deepIndexBase}/wallets/${address}/nfts?chain=${hex}&normalizeMetadata=true&media_items=true`;
```
- `normalizeMetadata=true` → populates `normalized_metadata` (name / image / description).
- `media_items=true` → adds Moralis-cached `media` (CDN URLs; far more reliable than raw IPFS/HTTP
  metadata images, which frequently 404).
- **Do NOT add `exclude_spam`.** Per the earlier "keep all wallet tokens, don't drop unfamiliar
  ones" decision, we do not let the provider drop NFTs.

## 2. Read the media object
Extend `MoralisNftHolding` (~line 98) to include Moralis media:
```ts
interface MoralisNftHolding {
  token_address?: string | null;
  token_id?: string | null;
  name?: string | null;
  contract_type?: string | null;
  collection_logo?: string | null;
  normalized_metadata?: { name?: string | null; image?: string | null; description?: string | null } | null;
  media?: {
    original_media_url?: string | null;
    media_collection?: {
      low?: { url?: string | null } | null;
      medium?: { url?: string | null } | null;
      high?: { url?: string | null } | null;
    } | null;
  } | null;
}
```

## 3. Prefer the CDN media for the image; normalize IPFS for the fallback
Raw `ipfs://` URLs won't load in an `<img>`, so add a tiny helper (module scope):
```ts
function toHttpImage(u: string | null | undefined): string | null {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}`;
  return u;
}
```
Then in the holdings map, set `logoUrl` from the best available source:
```ts
const media = it.media;
const mediaUrl =
  media?.media_collection?.high?.url ??
  media?.media_collection?.medium?.url ??
  media?.original_media_url ??
  null;
holdings.push({
  contractAddress,
  tokenId,
  name: it.normalized_metadata?.name ?? it.name ?? null,
  description: it.normalized_metadata?.description ?? null,
  collectionName: it.name ?? null,
  logoUrl: mediaUrl ?? toHttpImage(it.normalized_metadata?.image) ?? it.collection_logo ?? null,
  tokenStandard: it.contract_type ?? null,
});
```

## 4. (Optional, same root cause) history NFT transfers
The transfer-history NFT path can also carry metadata if you pass `nft_metadata=true` on the
`/wallets/{address}/history` request. Low priority — the **displayed** NFTs come from holdings, not
transfers — so add it only if cheap; otherwise leave it.

## 5. Validate
- typecheck + singleton check clean.
- Resync a wallet holding an NFT with metadata (e.g. an ENS name) → the `Nft` rows now store a
  `logoUrl` (a Moralis CDN URL) and `description`; the DTO returns both.
- Existing rows backfill on resync — `importNftHoldings`' update branch already writes
  `logoUrl`/`name`/`description` when present. **The user must resync the connected wallet after
  this ships** for already-imported NFTs to gain images/descriptions.
- Regression: `nfts` + `wallet-preview` suites green. If a wallet-preview test asserts NFT holdings,
  update its Moralis mock to include `media` / `normalized_metadata` so the image/description
  assertions reflect the new precedence (media → normalized image → collection logo).

## Out of scope
- **Floor price** (the modal's "—"): Moralis holdings don't return floor price; it needs a separate
  collection-stats / NFT-price call. Track as its own retrofit if wanted.
- Manual portfolios; the webhook stream path.
