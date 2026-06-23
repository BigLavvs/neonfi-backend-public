# retrofit-48 — Connected-wallet token accuracy: contract-based resolution + periodic re-price

## Why

Two accuracy gaps left by retrofit-47, both for connected wallets:

**(A) Resolution is symbol-only.** `Token.symbol` is the unique key and there's no contract column,
so syncing/auto-listing matches purely by ticker. A wallet's `FOO` (one real project) can be
mis-mapped onto a catalog `FOO` row for a *different* project. Adding a `contractAddress` column lets
us match by contract first (precise, the on-chain identity), only falling back to symbol.

**(B) Auto-listed tokens go stale.** Tokens auto-listed from a wallet aren't on the live exchange
firehose (it subscribes by symbol to exchange WS feeds, which don't carry long-tail tokens), so their
`Token.currentPrice` is frozen at sync time and the connected portfolio's total drifts. A small
periodic job re-reads those wallets and refreshes ONLY those tokens' price.

IMPORTANT CAVEAT (encode honestly, do not over-promise): `Token.symbol` remains the UNIQUE key in this
retrofit, so there can still be only ONE row per ticker. `contractAddress` makes resolution and
re-pricing *precise* and lets us detect a collision, but it does NOT let two same-ticker projects
coexist as separate catalog rows — fully separating them needs a larger change re-keying the catalog
to `(symbol, contractAddress)` (touches the firehose, webhook, and transactions, which all resolve by
symbol). That bigger re-key is explicitly OUT OF SCOPE here; on a genuine same-ticker/different-
contract collision we map to the existing row and LOG it (never drop, never crash).

Balances stay owned by the Moralis webhook stream; CMC/firehose tokens stay owned by token-sync + the
firehose. This retrofit only touches the read-side sync/reprice + adds one nullable column.

Depends on retrofit-47 (already merged, commit 4d0595d): `src/modules/wallet-data/` (providers,
`fetchWalletSummary`, `sync.ts`).

---

## 1. Schema — contract address + auto-listed flag

`prisma/schema.prisma`, `Token` model — add TWO nullable/defaulted columns (keep `symbol` as the
existing unique key — do NOT change it):
```prisma
// retrofit-48: on-chain identity for precise resolution + per-contract re-pricing. Nullable because
// existing CMC catalog rows have no contract recorded. NOT unique (the same contract string can recur
// across chains, and symbol stays the unique key) — index it for lookups only.
contractAddress  String?

// retrofit-48: true when this row was auto-created from a connected wallet's holdings (not the CMC
// catalog). These tokens are NOT on the live firehose, so the connected-reprice job refreshes their
// price. CMC/catalog tokens stay false and are priced by token-sync + the firehose.
autoListed       Boolean  @default(false)
```
Add an index: `@@index([contractAddress])`. Run: `npx prisma migrate dev --name token_contract_autolisted`
then `npx prisma generate`. Store contract addresses **lower-cased** for EVM (match the
wallet-validator's normalization); leave Solana mints as-is.

(Existing auto-listed tokens created before this migration default to `false`. Optional one-off
backfill — only if you already created connected portfolios while testing retrofit-47:
`UPDATE "Token" SET "autoListed" = true WHERE "rank" IS NULL AND "id" IN (SELECT DISTINCT "tokenId"
FROM "Asset" a JOIN "Portfolio" p ON a."portfolioId" = p.id JOIN "PortfolioType" t ON p."typeId" =
t.id WHERE t.name = 'connected');` — adapt table/column casing to the actual schema. Skip if you'll
just re-create the test portfolios.)

---

## 2. Sync — contract-first resolution + flag/store on auto-create

`src/modules/wallet-data/sync.ts` — change the per-token resolve/auto-create from retrofit-47:

1. **Resolve precisely.** For a wallet token `t` with a contract:
   - First try `prisma.token.findFirst({ where: { contractAddress: { equals: <t.contractAddress lower-cased>, mode: 'insensitive' } } })`.
   - If none, fall back to the existing symbol match (`symbol: { equals: t.symbol, mode: 'insensitive' }`).
   - Native tokens (no contract) resolve by symbol as before.
2. **Backfill contract on a symbol match.** If we matched by symbol and that row has `contractAddress == null` and `t.contractAddress` is set, update the row to record it (so future resolves are precise). Do NOT overwrite a row that already has a *different* contract.
3. **Collision detection.** If we matched by symbol but the existing row has a DIFFERENT non-null `contractAddress` than `t.contractAddress`, that's a genuine same-ticker/different-project collision. Because `symbol` is unique we can't create a second row — map the holding to the existing row (so it's not dropped) and `console.warn('[wallet-sync] ticker collision', { symbol, existing, incoming })`. (This is the documented limitation; the bigger catalog re-key is out of scope.)
4. **Auto-create.** When nothing matched, create the row with `autoListed: true` AND `contractAddress: <t.contractAddress lower-cased | null>` (plus the retrofit-47 fields: symbol upper-cased, name, currentPrice = `t.usdPrice ?? 0`, rank null). Guard the create against a concurrent same-symbol insert (the unique constraint) — catch P2002 and re-resolve to the now-existing row.

Everything else in the sync (opening-position seeding, per-token try/continue, recalc) is unchanged.

---

## 3. Reprice worker — `src/modules/wallet-data/reprice.ts`

```ts
import { prisma } from '../../lib/prisma.js';
import { fetchWalletSummary } from './index.js';

const DELAY_MS = 250; // gentle pacing between wallets (provider rate limits)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Re-read every connected wallet that holds ≥1 auto-listed token and refresh ONLY those tokens'
// currentPrice. Best-effort: never throws; per-wallet failures are logged and skipped. Returns
// counts for the scheduler log.
export async function repriceConnectedTokens(): Promise<{ wallets: number; repriced: number }> {
  // Distinct (walletAddress, chainSlug) of connected portfolios holding an auto-listed token.
  const assets = await prisma.asset.findMany({
    where: {
      token: { autoListed: true },
      portfolio: { type: { name: 'connected' }, walletAddress: { not: null } },
    },
    select: {
      portfolio: { select: { walletAddress: true, chain: { select: { slug: true } } } },
    },
  });

  const wallets = new Map<string, { address: string; slug: string }>();
  for (const a of assets) {
    const address = a.portfolio.walletAddress;
    const slug = a.portfolio.chain?.slug;
    if (!address || !slug) continue;
    wallets.set(`${address}|${slug}`, { address, slug });
  }

  let repriced = 0;
  for (const { address, slug } of wallets.values()) {
    try {
      const summary = await fetchWalletSummary(address, { slug });
      if (!summary) continue;
      for (const t of summary.tokens) {
        if (t.usdPrice == null) continue;
        // Match auto-listed rows by CONTRACT when available (precise), else by symbol. Scoped to
        // autoListed:true so a CMC/firehose-priced token is never clobbered.
        const where = t.contractAddress
          ? { contractAddress: { equals: t.contractAddress.toLowerCase(), mode: 'insensitive' as const }, autoListed: true }
          : { symbol: { equals: t.symbol, mode: 'insensitive' as const }, autoListed: true };
        const res = await prisma.token.updateMany({ where, data: { currentPrice: t.usdPrice } });
        repriced += res.count;
      }
    } catch (e) {
      console.error('[connected-reprice] wallet failed', { slug }, e);
    }
    await sleep(DELAY_MS);
  }

  return { wallets: wallets.size, repriced };
}
```
(Adapt the `currentPrice` field name / Decimal handling to the actual `Token` model — pass a string
if it's a Prisma `Decimal`.)

---

## 4. Config — `src/lib/config.ts`

In the jobs area (near `TOKEN_SYNC_ENABLED`), mirror the explicit-transform boolean pattern:
```ts
// retrofit-48: periodic re-price of auto-listed connected-wallet tokens (not on the live firehose).
// Explicit transform, NOT z.coerce.boolean() — Boolean("false") === true would never disable.
CONNECTED_REPRICE_ENABLED: z
  .string()
  .transform((v) => v === 'true')
  .default('true'),
CONNECTED_REPRICE_CRON: z
  .string()
  .default('*/30 * * * *')
  .refine((v) => cron.validate(v), 'CONNECTED_REPRICE_CRON must be a valid cron expression'),
```

---

## 5. Scheduler — `src/jobs/connected-reprice.job.ts`

Mirror `src/jobs/token-sync.job.ts` exactly:
```ts
import cron from 'node-cron';
import { config } from '../lib/config.js';
import { repriceConnectedTokens } from '../modules/wallet-data/reprice.js';

export function startConnectedRepriceScheduler(): void {
  if (!config.CONNECTED_REPRICE_ENABLED) {
    console.log('[connected-reprice] disabled via env (CONNECTED_REPRICE_ENABLED=false)');
    return;
  }
  const expr = config.CONNECTED_REPRICE_CRON;
  cron.schedule(expr, async () => {
    try {
      const r = await repriceConnectedTokens();
      console.log(`[connected-reprice] done — wallets:${r.wallets} repriced:${r.repriced}`);
    } catch (e) {
      console.error('[connected-reprice] uncaught error:', e);
    }
  });
  console.log(`[connected-reprice] scheduler started (cron: ${expr})`);
}
```

Register it in `src/index.ts` right next to the existing `startTokenSyncScheduler()` /
snapshot-scheduler calls.

---

## 6. Validate

- `npm run typecheck` + `node scripts/check-singletons.mjs` clean.
- **Update retrofit-47's `wallet-preview.test.ts`** for the new auto-create fields: an auto-listed
  token row now has `autoListed: true` and `contractAddress` = the provider token's (lower-cased)
  contract. Add sync-resolution cases:
  - Wallet token whose contract matches an existing row → resolves to it (no new row).
  - Wallet token whose symbol matches a row with `contractAddress: null` → matched + the row's
    `contractAddress` is backfilled.
  - Wallet token whose symbol matches a row with a DIFFERENT contract → maps to the existing row + a
    warning is logged; no duplicate row, no throw.
- New `reprice.test.ts` (mirror `wallet-preview.test.ts` style — real DB, mock `fetchWalletSummary`):
  - Seed a connected portfolio holding an `autoListed: true` token (with a contractAddress) + a normal
    CMC token. Mock `fetchWalletSummary` to return fresh prices for both.
  - Run `repriceConnectedTokens()` → the auto-listed token's `currentPrice` updates (matched by
    contract); the CMC token is unchanged; returns `{ wallets: 1, repriced: 1 }`.
  - A wallet whose `fetchWalletSummary` throws → logged, skipped, others still processed.
- Confirm the scheduler logs "scheduler started" on boot and "disabled" when
  `CONNECTED_REPRICE_ENABLED=false`.
- Regression: re-run `portfolios`, `transactions`, `assets`, `overview`, and the retrofit-47 wallet
  suites green.

## Out of scope (do NOT touch)
- Balances / transactions (webhook stream owns connected balances).
- CMC token-sync, the firehose, retrofit-47's provider parsers / preview endpoint.
