# retrofit-47 — Connected-wallet preview (multi-provider) + initial holdings sync

## Why

Connecting a wallet today only validates the address *format* and registers a Moralis
**stream** for future webhook events (`src/modules/portfolios/portfolios.service.ts:74-121`).
It never reads the wallet, so the UI's "Connected / Assets sync after create" is purely cosmetic
and the portfolio starts empty.

We want, at connect time, to actually **look up the wallet** across several data providers and show
the user a summary (native balance, total assets, total USD). And on create, do an **initial sync**
so the portfolio shows its current holdings immediately (the stream keeps it updated afterward).

Provider order (try in sequence, first success wins): **Moralis → Covalent (GoldRush) → Alchemy →
Ankr**. Each fallback is **gated on its own optional API key** — a provider with no key is skipped.

Behaviour the frontend expects (three outcomes):
- **found** — a provider returned holdings → return a summary.
- **empty** — address is well-formed but no provider reports holdings (new/empty wallet, or none
  could verify). Frontend will say "this wallet looks empty — add it anyway?" (webhooks may populate
  it later).
- **invalid** — the address fails format validation for the chain → frontend says "couldn't find a
  wallet with this chain and address."

DO NOT change the existing Moralis **stream** registration or the webhook handler — only ADD the
read-side provider layer, a preview endpoint, and the initial sync.

---

## 1. Config — add three OPTIONAL provider keys

`src/lib/config.ts`, in the "Blockchain / token" group (near `MORALIS_API_KEY`):

```ts
// retrofit-47: read-side wallet-data providers. Moralis (already required) is primary; these
// three are OPTIONAL fallbacks — a provider with no key is skipped in the preview/sync chain.
GOLDRUSH_API_KEY: z.string().optional(),   // Covalent / GoldRush (covalenthq.com); key prefix cqt_
ALCHEMY_API_KEY: z.string().optional(),
ANKR_API_KEY: z.string().optional(),
// Moralis Web3 Data API base (distinct from the streams base in moralis-streams-client.ts).
MORALIS_DEEP_INDEX_BASE: z.string().min(1).default('https://deep-index.moralis.io/api/v2.2'),
MORALIS_SOLANA_BASE: z.string().min(1).default('https://solana-gateway.moralis.io'),
```

---

## 2. New module: `src/modules/wallet-data/`

### 2a. `types.ts`

```ts
export interface WalletToken {
  symbol: string;
  name: string | null;            // token name (for auto-listing non-catalog tokens on sync)
  contractAddress: string | null; // null for native
  balance: number;                // human-readable (formatted) units
  decimals: number | null;
  usdPrice: number | null;        // per-unit USD price from the provider (for valuation/auto-list)
  usdValue: number | null;        // null when a provider can't price it
  isNative: boolean;
}

export interface WalletSummary {
  nativeSymbol: string;
  nativeBalance: number;
  totalUsd: number | null;        // null if NO token had a USD value
  tokenCount: number;             // distinct tokens with balance > 0 (incl. native if > 0)
  tokens: WalletToken[];          // all tokens with balance > 0, sorted by usdValue desc (nulls last)
  provider: string;               // which provider produced this
}

// Per-provider outcome. 'error' = provider failed/unsupported/no-key → try the next one.
export type ProviderStatus = 'ok' | 'empty' | 'error';
export interface ProviderResult {
  status: ProviderStatus;
  summary?: WalletSummary; // present when status === 'ok'
}

export interface WalletDataProvider {
  name: string;
  isConfigured(): boolean;            // key present?
  supportsChain(chainSlug: string): boolean;
  getSummary(address: string, chainSlug: string): Promise<ProviderResult>;
}
```

### 2b. Per-provider chain maps + implementations (`providers/`)

Each provider maps our chain `slug` (see `src/modules/chains/chains.constants.ts`:
`eth, polygon, bnb, arbitrum, optimism, base, avalanche, solana, fantom, linea, zksync,
polygon-zkevm, cronos, gnosis, mantle`) → that provider's identifier. If a slug isn't in the map,
`supportsChain` is false and the provider is skipped for that chain.

General rules for every provider:
- `isConfigured()` returns false when the key is missing → skipped.
- Network/HTTP/parse failure → return `{ status: 'error' }` (never throw out of `getSummary`).
- **Spam filtering (accuracy, not catalog-gating):** EXCLUDE only tokens the provider flags as spam
  (Covalent `is_spam`/use `no-spam=true`; Moralis `possible_spam: true`; Ankr `onlyWhitelisted: true`)
  AND zero/near-zero-value dust (`usdValue == null && !isNative` → drop; an unpriced non-native token
  is almost always junk). Keep EVERY other token regardless of whether it's in our catalog — the goal
  is to reflect the wallet accurately. Native is always kept if balance > 0.
- A successful response with ≥1 kept token (balance>0) → `{ status: 'ok', summary }`; zero kept → `{ status: 'empty' }`.
- Build `tokens[]` from the kept tokens, populate `name`/`usdPrice` per token, compute `totalUsd` =
  sum of non-null `usdValue`, `tokenCount` = tokens.length, `nativeSymbol`/`nativeBalance` from the
  native entry (0 if none). Sort tokens by usdValue desc (nulls last). Cap stored tokens at ~100.

**`providers/moralis.ts`** (primary — `MORALIS_API_KEY`, header `X-API-Key`)
- EVM: `GET {MORALIS_DEEP_INDEX_BASE}/wallets/{address}/tokens?chain={moralisId}` (moralisId = the hex
  from chains.constants, e.g. `0x1`). Response `result[]` items: `{ symbol, name, token_address,
  decimals, balance_formatted, usd_value, usd_price, native_token }`. Native is the item with
  `native_token: true`. 400/empty handling per general rules.
- Solana: `GET {MORALIS_SOLANA_BASE}/account/mainnet/{address}/portfolio` → `{ nativeBalance:
  { solana }, tokens: [{ symbol, associatedTokenAddress, amount, decimals }] }`. USD may be absent →
  usdValue null (totalUsd null is OK; summary still shows balances + count).
- supportsChain: all 15 slugs (Moralis covers EVM via hex + Solana).

**`providers/goldrush.ts`** (Covalent / GoldRush — `GOLDRUSH_API_KEY`, header `Authorization: Bearer <key>`)
- `GET https://api.covalenthq.com/v1/{cov}/address/{address}/balances_v2/?quote-currency=USD&no-spam=true`
- chain map `cov`: eth→`eth-mainnet`, polygon→`matic-mainnet`, bnb→`bsc-mainnet`,
  arbitrum→`arbitrum-mainnet`, optimism→`optimism-mainnet`, base→`base-mainnet`,
  avalanche→`avalanche-mainnet`, fantom→`fantom-mainnet`, linea→`linea-mainnet`,
  zksync→`zksync-mainnet`, gnosis→`gnosis-mainnet`, cronos→`cronos-mainnet`, mantle→`mantle-mainnet`,
  solana→`solana-mainnet`. (polygon-zkevm: omit if unsure.)
- Response `data.items[]`: `{ contract_ticker_symbol, contract_decimals, contract_address, balance
  (raw string), quote (USD number), quote_rate, native_token }`. balance human = balance / 10^decimals.

**`providers/alchemy.ts`** (`ALCHEMY_API_KEY`)
- chain map → network subdomain: eth→`eth-mainnet`, polygon→`polygon-mainnet`, arbitrum→`arb-mainnet`,
  optimism→`opt-mainnet`, base→`base-mainnet`, avalanche→`avax-mainnet`, bnb→`bnb-mainnet`,
  fantom→`fantom-mainnet`, linea→`linea-mainnet`, gnosis→`gnosis-mainnet`, solana→`solana-mainnet`.
- Prefer the Data/Portfolio API if simple: `POST https://api.g.alchemy.com/data/v1/{key}/assets/tokens/by-address`
  with `{ addresses:[{ address, networks:[<network>] }] }` → tokens with balance + metadata (+ price on
  supported tiers). If that's not available, fall back to JSON-RPC on
  `https://{network}.g.alchemy.com/v2/{key}`: `eth_getBalance` (native) + `alchemy_getTokenBalances`
  + `alchemy_getTokenMetadata` (symbol/decimals). USD via the Prices API
  `https://api.g.alchemy.com/prices/v1/{key}/tokens/by-address` is OPTIONAL — if not wired, leave
  usdValue null (summary still shows balances + count).

**`providers/ankr.ts`** (`ANKR_API_KEY`)
- `POST https://rpc.ankr.com/multichain/{ANKR_API_KEY}`, JSON-RPC body
  `{ jsonrpc:'2.0', id:1, method:'ankr_getAccountBalance', params:{ blockchain:<ankr>, walletAddress:address, onlyWhitelisted:true } }`.
- chain map `ankr`: eth→`eth`, polygon→`polygon`, bnb→`bsc`, arbitrum→`arbitrum`,
  optimism→`optimism`, base→`base`, avalanche→`avalanche`, fantom→`fantom`, linea→`linea`,
  gnosis→`gnosis`. (No Solana on this endpoint → supportsChain('solana')=false.)
- Response `result.assets[]`: `{ blockchain, tokenName, tokenSymbol, tokenDecimals, balance,
  balanceUsd, contractAddress?, tokenType }`. balance is already human-readable; balanceUsd is USD.

### 2c. `index.ts` — orchestrator

```ts
import { validateWalletAddress } from '../portfolios/wallet-validator.js';
// build PROVIDERS in priority order: [moralis, goldrush, alchemy, ankr] (each included only if isConfigured())

export type PreviewStatus = 'found' | 'empty' | 'invalid';
export interface WalletPreview { status: PreviewStatus; summary?: WalletSummary; }

export async function previewWallet(address: string, chain: { slug: string }): Promise<WalletPreview> {
  const v = validateWalletAddress(address, chain);
  if (!v.valid) return { status: 'invalid' };
  const addr = v.normalized!;
  let sawResponse = false; // any provider responded (ok or empty) — distinguishes empty vs all-error
  for (const p of PROVIDERS) {
    if (!p.isConfigured() || !p.supportsChain(chain.slug)) continue;
    const r = await p.getSummary(addr, chain.slug);
    if (r.status === 'ok' && r.summary) return { status: 'found', summary: r.summary };
    if (r.status === 'empty') sawResponse = true;
  }
  // Well-formed address but no holdings anywhere (or nobody could verify) → 'empty' (add-anyway).
  return { status: 'empty' };
}

// Used by the initial sync — returns the winning summary (or null).
export async function fetchWalletSummary(address: string, chain: { slug: string }): Promise<WalletSummary | null> {
  const p = await previewWallet(address, chain);
  return p.summary ?? null;
}
```

---

## 3. Preview endpoint

`src/modules/portfolios/portfolios.schemas.ts` — add:
```ts
export const walletPreviewSchema = z.object({
  walletAddress: z.string().min(1),
  chainId: z.number().int().positive(),
});
```

`src/modules/portfolios/portfolios.controller.ts` — add an authed route (mirror the auth/validation
style of the existing create route):
```ts
// POST /api/v1/portfolios/wallet/preview  (retrofit-47)
router.post('/wallet/preview', requireAuth, async (c) => {
  const body = walletPreviewSchema.parse(await c.req.json());
  const chain = await prisma.chain.findUnique({ where: { id: body.chainId } });
  if (!chain) return c.json(err('INVALID_CHAIN', 'Chain not found'), 400);
  // Reuse the existing free-tier chain gate (FREE_TIER_CHAIN_SLUGS) so the preview matches what
  // create will allow.
  const preview = await previewWallet(body.walletAddress, chain);
  return c.json(ok(preview), 200);
});
```
Place it BEFORE any `/:id` route so it isn't shadowed. Response envelope: `{ data: { status,
summary? } }`.

---

## 4. Initial holdings sync on create

In `createPortfolio` (`portfolios.service.ts`), connected branch, AFTER the stream registration
(`portfolios.service.ts:104-119`) and BEFORE `return await toPortfolioDTO(portfolio)`:

```ts
// retrofit-47: initial holdings sync. Best-effort — log & continue on failure (portfolio still
// created; the stream will populate it going forward).
try {
  await syncConnectedHoldings(portfolio.id, validation.normalized!, chain);
} catch (e) {
  console.error('[wallet-sync] initial sync failed', e);
}
```

Add `syncConnectedHoldings(portfolioId, address, chain)` (in portfolios.service.ts or a new
`wallet-data/sync.ts`):
1. `const summary = await fetchWalletSummary(address, chain);` → if null/empty, return (nothing to seed).
2. For each `summary.tokens` entry with `balance > 0`:
   - Resolve a catalog Token by **contract address first** (most precise), else by symbol
     (case-insensitive). Inspect the Prisma `Token` model for the actual columns; e.g.
     `prisma.token.findFirst({ where: { OR: [ ...(t.contractAddress ? [{ contractAddress: t.contractAddress }] : []), { symbol: { equals: t.symbol, mode: 'insensitive' } } ] } })`.
     If there's no contract column, match by symbol only.
   - **If no catalog match, AUTO-CREATE a Token row** from the provider metadata so the holding is kept.
     THIS IS THE ACCURACY FIX: unlike the webhook's *stream* path (`moralis-handlers.ts:298-309`, which
     skips unknown tokens to keep spam airdrops out of the catalog), the initial sync reflects the user's
     real current bag, and the provider already gave us balance + price. Create with: `symbol`
     (upper-cased), `name` = `t.name ?? t.symbol`, `decimals` = `t.decimals ?? 18`, the contract address
     if that column exists, `currentPrice` = `t.usdPrice ?? 0`, `rank: null`, `logoUrl: null`, and — only
     if such a column already exists — a `source: 'wallet'` / `autoListed: true` marker (do NOT invent
     schema; inspect the model). Use `upsert` keyed on the real unique column (symbol or contractAddress)
     so re-syncs are idempotent and concurrent creates don't race. Spam/dust was already excluded in §2b,
     so only real holdings reach here.
   - Seed an **opening position** for the current balance so it reads as a pre-existing holding (not a
     fresh buy). Reuse `seedAcquisitionInTx` (`transactions.service.ts:399`) inside a `prisma.$transaction`,
     `amount = balance`, `priceAtTime = t.usdPrice` when available (cost basis ≈ current value → unrealized
     PnL starts ≈ 0; omit when null). `timestamp = now`.
3. After seeding, recalc + `invalidatePnlCache(portfolioId)` (mirror the manual-create seeding path,
   `portfolios.service.ts:170-189`).
4. Per-token failures: log & continue (one bad token must not abort the rest); keep each token's seed atomic.

LIVE-PRICING CAVEAT (put this in a code comment): auto-listed tokens are NOT in the live price firehose
(it subscribes by symbol to the exchange WS streams), so their value holds at the synced price until a
future refresh — accurate at sync time, and far better than dropping real holdings. A later retrofit can
fold these into a periodic price refresh / re-sync.

Note: the stream only captures transfers AFTER creation, so seeding the current balance now + future
webhook deltas = correct (no double counting).

---

## 5. Validate

- `npm run check` / typecheck clean.
- With only `MORALIS_API_KEY` set: preview works via Moralis; the other three are skipped (not errors).
- Preview a known non-empty EVM wallet → `found` + summary (native balance, tokenCount, totalUsd).
- Preview a freshly-generated unused EVM address → `empty`.
- Preview a malformed address → `invalid`.
- Create a connected portfolio for a non-empty wallet → ALL non-spam holdings appear immediately
  (non-catalog tokens are auto-listed), portfolio total ≈ the provider summary, netDeposit/PnL sane,
  existing stream registration unchanged.
- Confirm spam/dust is excluded: a wallet with scam-airdrop tokens shows only the real holdings, and
  the total isn't inflated by zero-value junk.
- Unit-test the orchestrator with mocked providers (configured/unconfigured, ok/empty/error ordering)
  and each provider's parser with a sample payload (mirror the existing test style for moralis-handlers).

## Out of scope (do NOT touch)
- The Moralis streams client / webhook handler / signature verification.
- The manual-portfolio create path.
- Frontend (handled separately).
