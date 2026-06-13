# Neonfi backend — Stage 9B: Token Metadata Sync job

This file is the source-of-truth intent for Stage 9B. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 9A landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-9a.md` (this repo). Stage 9B is the scheduled counterpart to 9A's CRUD endpoints — 9A wrote the user-driven transaction surface, 9B writes the system-driven token-catalog freshening. The two don't directly interact, but they both inform how product price/value math behaves.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 9 in §3 in full** (especially the Token Module + Token sync notes), **§System_Implementation Scheduled Jobs** (the cadence + placement notes), **§2.5 Caching** (token metadata Redis 24h TTL).
3. `Neonfi System Architecture.docx` — **Token Module** rules, **TOKEN entity** resource rep (what fields update vs stay stable).
4. `Neonfi System Implementation.docx` — §3 Required Environment Variables (you'll add 1–2 new ones), §Scheduled Jobs.
5. `src/jobs/token-sync.job.ts` — Stage 1A placeholder. Stage 9B fills it in. Currently a no-op stub.
6. `src/lib/config.ts` — env-var validation. Stage 9B adds the new vars.
7. `src/index.ts` — app start. Stage 9B adds scheduler init here, gated by NODE_ENV.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Vendor abstraction — interface + adapter pattern [LOCKED]

Appendix item 2 keeps the vendor open (Moralis primary; CoinMarketCap / CoinRanking under evaluation pending a coverage spike on the 250+ list). Stage 9B implements ONE adapter (Moralis) but routes everything through an interface so future adapters can drop in without touching the sync logic.

Interface:

```ts
// src/modules/tokens/sync/provider.ts
export interface TokenMetadata {
  symbol: string;
  currentPrice: string;   // decimal string for precision
  marketCap: string | null;
  rank: number | null;
}

export interface TokenMetadataProvider {
  readonly name: string;  // e.g., 'moralis', 'coinmarketcap'
  fetchMetadata(symbols: string[]): Promise<Map<string, TokenMetadata>>;
}
```

`fetchMetadata` takes the symbols we want to refresh and returns a Map keyed by symbol. Tokens the vendor doesn't recognize are simply absent from the Map (not thrown). The sync function logs missing symbols and skips them — `prisma.token.update` only runs for the symbols the vendor returned.

### 1.2 Moralis adapter [LOCKED — single adapter for MVP]

Implement `src/modules/tokens/sync/moralis-provider.ts` exporting `MoralisTokenMetadataProvider` implementing the interface. Use Moralis's Token Price endpoint (the EVM Token API has `/erc20/prices` taking an array of token addresses, but we have symbols not addresses — so use the symbol-based "Get Token Price" endpoint or equivalent in the current Moralis API).

**Don't get stuck on Moralis API specifics.** Stage 9B isn't a Moralis-API-correctness stage; it's the wiring stage. Pick the most reasonable Moralis endpoint that returns price-by-symbol (or batch the per-chain queries if symbol-based isn't available). If the Moralis API quirks block forward progress, fall back to a stub provider that returns the existing Token row values unchanged (effectively a no-op) and surface the API question to Idowu. Stage 9B doesn't have to actually hit Moralis successfully on the first build — the architecture has to be right and the test path has to exercise the adapter with mocked HTTP.

For HTTP: use the built-in `fetch` (Node 18+). No new HTTP client deps.

### 1.3 Scheduling — `node-cron` library [LOCKED]

Install `node-cron` as a runtime dep (~5KB, no native deps, well-maintained). Define the schedule once:

```ts
// src/jobs/token-sync.job.ts
import cron from 'node-cron';
import { runTokenMetadataSync } from '../modules/tokens/sync/sync.js';

export function startTokenSyncScheduler(): void {
  const expr = config.TOKEN_SYNC_CRON;  // default '0 */6 * * *' — every 6 hours
  if (!config.TOKEN_SYNC_ENABLED) {
    console.log('[token-sync] disabled via env (TOKEN_SYNC_ENABLED=false)');
    return;
  }
  cron.schedule(expr, async () => {
    try {
      await runTokenMetadataSync();
    } catch (e) {
      // never crash the scheduler — log + continue
      console.error('[token-sync] uncaught error:', e);
    }
  });
  console.log(`[token-sync] scheduler started (cron: ${expr})`);
}
```

Call `startTokenSyncScheduler()` from `src/index.ts` after the Hono server starts, gated by `NODE_ENV`:

```ts
// src/index.ts
if (config.NODE_ENV !== 'test') {
  startTokenSyncScheduler();
}
```

This is the same pattern Stage 10 will eventually use for the Coinbase WS connection — long-running background processes start at app boot, are disabled in test.

### 1.4 New env vars [LOCKED]

Add to `src/lib/config.ts` (Zod schema) and `.env.example`:

- `TOKEN_SYNC_ENABLED` — boolean, default `true`. Allows disabling the scheduler entirely (useful in dev when you don't want the job spamming Moralis or your logs).
- `TOKEN_SYNC_CRON` — cron expression string, default `'0 */6 * * *'` (every 6 hours at minute 0). Validate with `node-cron`'s `validate()` function.

Existing `MORALIS_API_KEY` is reused — no new Moralis-specific env var. `TOKEN_METADATA_VENDOR` is NOT added — single adapter for MVP, swap by code change when the time comes.

Both new vars are OPTIONAL in the Zod schema (have defaults). The app still boots without them set.

### 1.5 Sync function — pull all, batch query, upsert each [LOCKED]

```ts
// src/modules/tokens/sync/sync.ts
export async function runTokenMetadataSync(
  provider: TokenMetadataProvider = defaultProvider,
): Promise<{ updated: number; skipped: number; failed: number; durationMs: number }> {
  const t0 = Date.now();
  const tokens = await prisma.token.findMany({ select: { symbol: true } });
  const symbols = tokens.map((t) => t.symbol);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const metadata = await provider.fetchMetadata(symbols);
    for (const symbol of symbols) {
      const meta = metadata.get(symbol);
      if (!meta) {
        skipped++;
        continue;
      }
      try {
        await prisma.token.update({
          where: { symbol },
          data: {
            currentPrice: meta.currentPrice,
            marketCap: meta.marketCap,
            rank: meta.rank ?? undefined,  // don't overwrite rank with null
          },
        });
        await redis.del(`token_meta:${symbol}`);  // invalidate cache, even though Stage 9B doesn't populate it
        updated++;
      } catch (e) {
        failed++;
        console.error(`[token-sync] failed to update ${symbol}:`, e);
      }
    }
  } catch (e) {
    console.error('[token-sync] provider fetch failed:', e);
    failed = symbols.length;
  }

  const durationMs = Date.now() - t0;
  console.log(`[token-sync] complete vendor=${provider.name} updated=${updated} skipped=${skipped} failed=${failed} duration=${durationMs}ms`);
  return { updated, skipped, failed, durationMs };
}
```

Default provider is constructed lazily and cached:

```ts
let _defaultProvider: TokenMetadataProvider | null = null;
function defaultProvider(): TokenMetadataProvider {
  if (!_defaultProvider) {
    _defaultProvider = new MoralisTokenMetadataProvider(config.MORALIS_API_KEY);
  }
  return _defaultProvider;
}
```

Tests inject their own mock provider via the function argument.

### 1.6 Cache invalidation — `token_meta:<symbol>` keys [LOCKED for the pattern]

Per Build Guide §2.5: token metadata cached in Redis with 24h TTL, invalidated on sync-job completion.

Stage 9B's sync function invalidates `token_meta:<symbol>` keys after each successful update. The cache is **read by** future code (likely Stage 10 or anywhere reading Token data hot-path) — Stage 9B doesn't add any reader. The invalidation is forward-compatible: when Stage 10 or later wires a reader that populates the cache, Stage 9B's invalidation already does the right thing.

For Stage 9B alone, the Redis del calls are essentially no-ops (keys don't exist yet). Don't pre-warm the cache here; the cache is read-through (populated on read miss), not write-through.

### 1.7 Failure handling — log + continue, don't crash [LOCKED]

Three failure modes:

1. **Provider fetch throws** (Moralis is down, rate-limited, network blip): catch at the top of the sync function. Log structured error with vendor name + error message. Set `failed = symbols.length` in the report. The job completes; the next scheduled run will retry.
2. **Individual token update fails** (DB constraint, lookup error): catch per-symbol. Increment `failed` counter. Continue to the next symbol.
3. **Scheduler itself crashes** (uncaught exception): wrap the `cron.schedule()` callback in try/catch (per §1.3). The scheduler keeps running.

All errors log to stdout via `console.error` per the existing pattern (Build Guide §6.8 says structured stdout logging is sufficient at MVP). No retry-with-backoff at this stage — the next scheduled run is the retry.

### 1.8 Test strategy — mock provider, call sync directly [LOCKED]

`runTokenMetadataSync` accepts a provider argument. Tests inject a mock provider returning controlled metadata. No node-cron in tests (NODE_ENV=test gates the scheduler init). No real HTTP calls to Moralis (provider is mocked entirely).

Test cases verify:
- Sync function updates Token rows correctly
- Sync function invalidates Redis cache keys for updated symbols
- Sync function handles missing symbols (vendor doesn't return all requested)
- Sync function handles per-symbol failures gracefully
- Sync function returns the expected stats
- Sync function handles provider-throws case (returns failed count)

## 2. Module scope

```
src/modules/tokens/sync/provider.ts          # NEW — TokenMetadataProvider interface + TokenMetadata type
src/modules/tokens/sync/moralis-provider.ts  # NEW — MoralisTokenMetadataProvider class
src/modules/tokens/sync/sync.ts              # NEW — runTokenMetadataSync function
src/jobs/token-sync.job.ts                   # EDIT — replace placeholder with startTokenSyncScheduler
src/lib/config.ts                            # EDIT — add TOKEN_SYNC_ENABLED, TOKEN_SYNC_CRON
.env.example                                 # EDIT — document the two new env vars
src/index.ts                                 # EDIT — call startTokenSyncScheduler when NODE_ENV !== 'test'
package.json                                 # EDIT — add node-cron dep
tests/token-sync.test.ts                     # NEW — ~8 tests
```

Do NOT touch any other module directory.

## 3. No endpoints

Stage 9B has zero HTTP endpoints. The job is purely background. The Token CRUD reads (Stage 6) continue to work without modification.

## 4. Cross-cutting wiring

### 4.1 Install node-cron

```bash
npm install node-cron
npm install --save-dev @types/node-cron
```

Verify it appears in `package.json`. The lockfile updates accordingly.

### 4.2 Env-var validation

In `src/lib/config.ts`, add to the Zod schema:

```ts
TOKEN_SYNC_ENABLED: z.coerce.boolean().default(true),
TOKEN_SYNC_CRON: z
  .string()
  .default('0 */6 * * *')
  .refine((v) => cron.validate(v), 'TOKEN_SYNC_CRON must be a valid cron expression'),
```

Import `cron` at the top: `import cron from 'node-cron';`. The `cron.validate()` function returns boolean — perfect for `.refine()`.

Add to `.env.example`:
```
# Token metadata sync (Stage 9B)
TOKEN_SYNC_ENABLED=true
TOKEN_SYNC_CRON=0 */6 * * *
```

### 4.3 Scheduler init in `src/index.ts`

After `app.listen()` or wherever the server starts:

```ts
import { startTokenSyncScheduler } from './jobs/token-sync.job.js';

// ...existing server start code...

if (config.NODE_ENV !== 'test') {
  startTokenSyncScheduler();
}
```

Test runs (NODE_ENV=test) skip the scheduler. Dev and prod runs start it.

### 4.4 Make sure Moralis provider doesn't crash app boot

If `MORALIS_API_KEY` is missing or invalid, the MoralisTokenMetadataProvider constructor shouldn't throw at app boot. Defer credential issues to fetch time — log and return an empty Map on first fetch attempt. App should boot even without Moralis configured (useful in dev with placeholder env vars).

## 5. Tests (Vitest, integration — new file `tests/token-sync.test.ts`)

Test numbering continues from Stage 9A's final count (224).

Setup: `beforeEach` clears Redis `token_meta:*` keys; does NOT touch the Token table (tokens stay seeded). The sync mutates Token rows, so `afterEach` restores the seed values for any token the test modified (or run the full seed afterEach — slower but bulletproof).

**Use a mock provider, NOT the real Moralis adapter.**

### Sync function — 8 tests

225. **Happy path: provider returns metadata for 3 symbols** → updated=3, skipped=0, failed=0; Token rows reflect new currentPrice/marketCap/rank.
226. **Skipped symbols: provider returns metadata for only 2 of 3** → updated=2, skipped=1, failed=0; the un-returned symbol's Token row unchanged.
227. **Provider throws** → updated=0, skipped=0, failed=symbols.length; no Token rows modified; error logged.
228. **Single update fails: simulate a DB error on one symbol** → updated=2, skipped=0, failed=1; the other two symbols' rows updated.
229. **Redis cache invalidation**: pre-seed `token_meta:BTC` with a value; run sync (provider returns BTC); `token_meta:BTC` is gone after.
230. **Rank null in provider response**: provider returns metadata with `rank: null` for BTC; sync does NOT overwrite Token.rank with null (uses `undefined` per the spec — Prisma treats undefined as "don't update").
231. **Empty token table**: pre-mock provider to return empty map; sync completes with updated=0, skipped=0, failed=0.
232. **Stats reporting**: assert the return value of `runTokenMetadataSync` matches the expected `{ updated, skipped, failed, durationMs }` shape and durationMs > 0.

Total new tests: 8. After Stage 9B: ~232 tests.

## 6. STOP-AND-ASK gates

1. **If `node-cron` install fails or has TS type issues** that can't be resolved with `@types/node-cron`, switch to a hand-rolled `setInterval` with a 6-hour interval. Document the deviation in the commit. Don't lose time fighting Cron expression parsing.
2. **If Moralis API endpoint shape is ambiguous** and you can't pick a clear endpoint to call: implement the provider as a placeholder that returns empty Map + logs a warning. Surface the question to Idowu — what specific Moralis endpoint should we call? The architecture works either way; the adapter just needs to compile.
3. **If existing 224 tests fail** after Stage 9B's config.ts change (new env vars), STOP. Defaults should mean existing test paths see the same behavior. Investigate config-load order.

## 7. What NOT to do

- **No CoinMarketCap or CoinRanking adapter.** Single vendor for MVP per Appendix item 2.
- **No real Moralis HTTP calls in tests.** Mock the provider entirely.
- **No retry-with-backoff inside the sync function.** Next scheduled run is the retry.
- **No vendor selection via env var (`TOKEN_METADATA_VENDOR`).** Hardcoded import of `MoralisTokenMetadataProvider` as the default. Future vendors are a code change, not a config change.
- **No new endpoints.** Token CRUD stays as Stage 6 specced.
- **No populating `Redis token_meta:<symbol>` keys** during sync. Cache is read-through; sync only invalidates.
- **No starting the scheduler during tests.** NODE_ENV=test gates the init.
- **No `prisma.$transaction` wrapping the sync.** Updates run independently; partial failure is acceptable. Token row updates aren't dependent on each other.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(token-sync): Stage 9B — vendor-agnostic token metadata sync job + node-cron scheduler"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation `node-cron` was added as a runtime dep.
- The two new env vars (`TOKEN_SYNC_ENABLED`, `TOKEN_SYNC_CRON`) appear in `.env.example` with defaults documented.
- Vitest output: all tests passing (count ~232+).
- The output of `runTokenMetadataSync(mockProvider)` in a happy-path test — the structured log line and the return value.
- Confirmation the scheduler doesn't start in tests (no `[token-sync] scheduler started` log line in vitest output).
- Doc-fix pile items added in Stage 9B:
  - `Neonfi System Implementation.docx` §3 Required Environment Variables: add `TOKEN_SYNC_ENABLED` and `TOKEN_SYNC_CRON`.
  - `Neonfi System Implementation.docx` Scheduled Jobs: clarify token-sync uses node-cron with default 6-hour cadence.
- Whether the Moralis provider actually hits a real endpoint or is a placeholder (per STOP gate 2 — both are acceptable Stage 9B outcomes; surface which one you took).
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
