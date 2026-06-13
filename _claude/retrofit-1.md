# Neonfi backend — Retrofit 1: 6 cheap audit fixes

This file is the source-of-truth intent for the first retrofit round. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 5a8096d (Stage 13).

Background: after a thorough audit reading all 4 source-of-truth docs against the codebase, several real bugs and divergences surfaced. This retrofit bundles the **6 lowest-risk fixes** — each independently verifiable, none requiring a design decision from Idowu, totalling well under 100 lines of changes. Bigger retrofits (Asset/Portfolio netDeposit tracking, Redis PnL cache wiring, snapshots/ module, Stage 14 analytics, Stage 15 email retries) come in later rounds.

## 0. Read first

Before touching any file, read it. The prior pattern of trusting prompt pseudocode without reading the code was the source of the divergences this audit surfaced. Each fix below cites the exact file:line you need to verify against.

1. `_claude/stage-9b.md` then `src/lib/config.ts` (lines 76-80) — for A6.
2. `src/modules/transactions/transactions.dto.ts` (entire file) and `Neonfi System Architecture.docx` Transaction entity (transactions.txt or architecture.txt line 518-534) — for A7.
3. `src/modules/auth/auth.service.ts` (lines 110-125 + 263-274) — for A11.
4. `src/modules/subscriptions/subscriptions.controller.ts` (line 59) and the §3.3 Hono v4 sub-router root convention used by every OTHER router (e.g. `src/modules/portfolios/portfolios.controller.ts:44` uses `''`, NOT `'/'`) — for A15.
5. `src/index.ts` (entire — only 60 lines) — for A19.
6. `src/modules/tokens/sync/coinmarketcap-provider.ts` (lines 15, 42-60) — for A23.

## 1. Fix A6 — `TOKEN_SYNC_ENABLED=false` doesn't actually disable token sync [LOCKED]

**Real bug.** `src/lib/config.ts:76` uses:
```ts
TOKEN_SYNC_ENABLED: z.coerce.boolean().default(true),
```

`z.coerce.boolean()` calls `Boolean("false")` which equals `true` in JavaScript. Setting `TOKEN_SYNC_ENABLED=false` in .env does NOT disable the scheduler.

Stage 13 caught the same bug for `SNAPSHOT_ENABLED` and used the correct pattern. Apply the same pattern here:

```ts
// BEFORE (line 76)
TOKEN_SYNC_ENABLED: z.coerce.boolean().default(true),

// AFTER
// NOTE: deliberately NOT z.coerce.boolean() — Boolean("false") === true in JS,
// so "false" would NOT disable. Stage 13 caught the same bug for SNAPSHOT_ENABLED;
// mirror the same explicit-transform pattern here.
TOKEN_SYNC_ENABLED: z
  .string()
  .transform((v) => v === 'true')
  .default('true'),
```

Verify: in a test or manually, set `TOKEN_SYNC_ENABLED=false`, boot the app, see `[token-sync] disabled via env (TOKEN_SYNC_ENABLED=false)` log line.

## 2. Fix A7 — `Transaction.status` field missing entirely [LOCKED, MVP shortcut]

**Real schema-vs-architecture defect.** Architecture rep (architecture.txt:518-534) includes `"status": "completed | pending | failed"` on every Transaction. The Prisma schema has no status column. TransactionListDTO and TransactionDetailDTO never return status. Frontend modal likely expects this field.

For MVP, all transactions are effectively `'completed'` — manual transactions are user-logged after-the-fact, connected portfolio webhook events arrive after the on-chain transaction was confirmed. There is no "pending" or "failed" state to track yet.

**Apply the cheap fix**: hardcode `status: 'completed'` in both DTOs. No schema change. When real pending/failed states ship (post-MVP), add a column and replace the hardcoded value.

In `src/modules/transactions/transactions.dto.ts`:

```ts
// Add 'status' field to TransactionListDTO interface (line 17)
export interface TransactionListDTO {
  id: number;
  portfolioId: number;
  type: string;
  direction: string;
  status: 'completed';  // NEW — hardcoded for MVP (no on-chain status tracking yet)
  from: string | null;
  to: string | null;
  gasFee: number | null;
  transactionHash: string | null;
  timestamp: string;
  createdAt: string;
}

// Add it to the mapper (line 54-67)
export function toTransactionListDTO(tx: TransactionWithTypeDirection): TransactionListDTO {
  return {
    id: tx.id,
    portfolioId: tx.portfolioId,
    type: tx.type.name,
    direction: tx.direction.name,
    status: 'completed',  // NEW
    from: tx.from ?? null,
    // ... rest unchanged
  };
}
```

`TransactionDetailDTO extends TransactionListDTO` (line 50) so it inherits status automatically. No change needed there.

Add to doc-fix pile: "Schema docx Transaction model: add `status` field or document that the architecture rep's status enum is post-MVP. Schema-vs-architecture defect of the same family as `Transaction.direction`."

## 3. Fix A11 — Verification URLs logged to stdout in production [LOCKED]

**Real security issue.** `auth.service.ts:117` and `:268` log the email verification URL unconditionally:
```ts
console.log(`[auth] verification URL for ${user.email}: ${verificationUrl}`);
```

In production this hits Coolify container logs. Anyone with log access can complete email verification for any registered user (since the URL contains the single-use verification token). Build Guide §6.8 logging rules: "Logs must NOT expose ... internal infrastructure topology, DB schema details, production stack traces, business-rule logic, or plaintext wallet addresses beyond debugging need." Verification tokens are not in the explicit list but match the same intent.

**Fix**: gate behind `isProduction === false`. The log line is useful in dev (lets you test without waiting for email).

```ts
// import isProduction (already imported as part of config destructuring — check existing imports)
import { config, isProduction } from '../../lib/config.js';

// At line 117 (register path):
if (!isProduction) {
  console.log(`[auth] verification URL for ${user.email}: ${verificationUrl}`);
}

// At line 268 (resendVerification path):
if (!isProduction) {
  console.log(`[auth] resend verification URL for ${user.email}: ${verificationUrl}`);
}
```

Note: `isProduction` is already exported from config.ts (line 119). Just import it.

## 4. Fix A15 — Hono sub-router root inconsistency [LOCKED]

**Latent bug** that bit Stages 3A and 4B earlier. Hono v4 expects `''` not `'/'` for sub-router root paths. Most modules use `''` correctly. ONE module is inconsistent:

`src/modules/subscriptions/subscriptions.controller.ts:59`:
```ts
router.post('/', requireAuth, async (c) => {  // ← inconsistent
```

Should be:
```ts
router.post('', requireAuth, async (c) => {
```

Verify by checking the other sub-routers: portfolios.controller.ts:44, assets.controller.ts:53, transactions.controller.ts:46, chains.controller.ts:9, tokens.controller.ts:14, payments.controller.ts:14, nfts.controller.ts (uses `router.get('', ...)`). All use `''`. Subscriptions is the outlier.

The reason existing tests still pass with `'/'` is that Hono v4 may treat trailing slash as a separate route OR the test suite's request paths happen to include the trailing slash. Either way, it's inconsistent and the established pattern is `''`. Fix it.

## 5. Fix A19 — Add graceful shutdown handlers in src/index.ts [LOCKED]

**Production hygiene.** No SIGTERM/SIGINT handlers. Coolify container stops drop WS connections, Coinbase, Redis subscriber without unsubscribe. Leaves orphan entries in Redis (`subs:<SYMBOL>` SETs full of dead socket IDs that the next process can't clean up because it doesn't know what was registered).

Add at the bottom of `src/index.ts` (after the `if (config.NODE_ENV !== 'test') {...}` block, before the `export { app };`):

```ts
async function shutdown(signal: string): Promise<void> {
  console.log(`[neonfi-backend] received ${signal}, shutting down gracefully`);
  
  // Lazy imports — only loaded when shutdown fires.
  const { stopWsServer } = await import('./ws/server.js');
  const { coinbase } = await import('./lib/coinbase.js');
  const { redis } = await import('./lib/redis.js');
  const { prisma } = await import('./lib/prisma.js');
  
  try {
    await stopWsServer();
  } catch (e) {
    console.error('[neonfi-backend] stopWsServer error:', e);
  }
  
  try {
    coinbase.disconnect();
  } catch (e) {
    console.error('[neonfi-backend] coinbase disconnect error:', e);
  }
  
  try {
    server.close();
  } catch (e) {
    console.error('[neonfi-backend] http server close error:', e);
  }
  
  try {
    await redis.quit();
  } catch (e) {
    console.error('[neonfi-backend] redis quit error:', e);
  }
  
  try {
    await prisma.$disconnect();
  } catch (e) {
    console.error('[neonfi-backend] prisma disconnect error:', e);
  }
  
  console.log('[neonfi-backend] shutdown complete');
  process.exit(0);
}

if (config.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
```

The lazy imports avoid forcing module load order at boot and let tests skip the shutdown machinery entirely.

Verify with a manual `kill -TERM <pid>` in dev — should see the "shutting down gracefully" log line followed by the dependency-close messages.

If the lazy-import pattern is awkward (e.g. TypeScript complaining about dynamic import paths), eager imports at the top of index.ts are also acceptable — same modules, just imported at boot time. Pick whichever feels cleaner.

## 6. Fix A23 — CMC `MAX_SYMBOLS_PER_CALL = 50` silently drops symbols >50 [LOCKED]

`coinmarketcap-provider.ts:15` hardcodes `MAX_SYMBOLS_PER_CALL = 50`. `_fetch` at line 48:
```ts
const batch = symbols.slice(0, MAX_SYMBOLS_PER_CALL).join(',');
```

`.slice(0, 50)` silently drops symbols beyond 50. The seed.ts currently seeds 30 tokens so this hasn't bit yet. But the moment Stage 9B's sync grows the token catalog past 50, every call silently misses the tail.

**Fix**: loop in batches of 50. Refactor `_fetch` to return aggregated results.

```ts
private async _fetch(symbols: string[]): Promise<CmcResponse | null> {
  if (!this.apiKey) {
    console.warn('[cmc-provider] COINMARKETCAP_API_KEY is not set — skipping fetch');
    return null;
  }
  
  // CMC accepts up to 50 symbols per call. Batch loop for catalogs > 50.
  const aggregated: CmcResponse = { data: {} };
  
  for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_CALL) {
    const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_CALL).join(',');
    const url = `${CMC_URL}?symbol=${encodeURIComponent(batch)}`;
    
    const res = await fetch(url, {
      headers: { 'X-CMC_PRO_API_KEY': this.apiKey, Accept: 'application/json' },
    });
    
    if (!res.ok) {
      throw new Error(`CMC HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    
    const body = await res.json() as CmcResponse;
    Object.assign(aggregated.data, body.data);
  }
  
  return aggregated;
}
```

Verify with a test: pass 60 unique symbols → assert two fetch calls were made → assert all 60 symbols are queryable in the returned Map.

## 7. Module scope

```
src/lib/config.ts                                          # EDIT — A6
src/modules/transactions/transactions.dto.ts               # EDIT — A7
src/modules/auth/auth.service.ts                           # EDIT — A11 (2 spots)
src/modules/subscriptions/subscriptions.controller.ts      # EDIT — A15
src/index.ts                                               # EDIT — A19
src/modules/tokens/sync/coinmarketcap-provider.ts          # EDIT — A23
tests/transactions.test.ts                                 # EDIT — 1 new assert that DTO includes status: 'completed'
tests/token-sync.test.ts                                   # EDIT — 1 new test for batch loop (60-symbol case)
```

No new files. No schema changes. No migration.

## 8. Tests

For each fix, add or update existing tests:

- **A6**: skip an explicit test — the boot-log behavior is hard to assert. Existing token-sync tests should still pass (they don't depend on the env var being honored). Manual verify only.
- **A7**: in `tests/transactions.test.ts`, find any test that asserts the shape of a TransactionDetailDTO or TransactionListDTO, and add `expect(...status).toBe('completed')`. ~1 line per assertion. If no test currently checks the shape exhaustively, add one new test: "GET /transactions/{id} returns status: 'completed'".
- **A11**: skip — would need console.log spy. Manual verify only.
- **A15**: existing subscriptions tests cover POST /subscriptions. They should still pass. If POST /subscriptions starts 404'ing after the change, that means tests were hitting `/subscriptions/` with trailing slash; investigate and adjust test paths (NOT the controller).
- **A19**: skip — shutdown handlers are hard to test in-process. Manual verify with `kill -TERM <pid>`.
- **A23**: add new test "60-symbol fetchMetadata makes 2 batches and returns all 60". Mock the fetch and assert call count + total symbols in result.

## 9. STOP-AND-ASK gates

1. **If subscriptions POST tests fail after A15**, do NOT revert. Investigate first: the tests may be hitting the route with trailing slash. Fix tests to drop the trailing slash from the path.
2. **If A19 graceful shutdown causes the `stopWsServer` import to fail** (circular import or missing export), surface and ask. The export `stopWsServer` exists in `src/ws/server.ts` per the file you should have read.
3. **If A7 adds `status: 'completed'` and any test that asserts the full DTO shape via `toEqual` breaks**, update each test's expected shape rather than removing the assertion. The shape change is intentional.
4. **If A23 batch refactor changes the return type** (e.g., from `Promise<CmcResponse | null>` to `Promise<CmcResponse>`), and downstream code in `fetchMetadata`/`fetchPrices` relies on the null check, preserve the original behavior (return null only when apiKey is missing).

## 10. What NOT to do

- **No schema changes.**
- **No new migrations.**
- **No editing docx files.** Doc-fix pile items get logged in the commit report.
- **No `npm audit fix`.**
- **No refactoring of unrelated code that "looks suspicious."** Stay strictly in scope.
- **No fixes to A1/A2/A3/A8 yet** — those need the USD-at-transaction-time decision from Idowu first.

## 11. Commit and report

Single commit:
```bash
git add -A
git commit -m "fix(retrofit-1): 6 audit fixes — TOKEN_SYNC_ENABLED Zod, Transaction.status, verification URL log, Hono sub-router root, graceful shutdown, CMC batching"
git log --oneline -5
```

Report:
- New commit SHA.
- One verification per fix:
  - **A6**: set `TOKEN_SYNC_ENABLED=false` temporarily, boot, confirm `[token-sync] disabled via env (TOKEN_SYNC_ENABLED=false)` log line, restore env to `true`.
  - **A7**: curl `GET /api/v1/portfolios/{id}/transactions/{id}` (or pull from a test) — show the response JSON contains `"status": "completed"`.
  - **A11**: grep `auth.service.ts` for both `console.log` lines and confirm both are gated.
  - **A15**: confirm `subscriptions.controller.ts:59` shows `router.post('', ...)`.
  - **A19**: grep `index.ts` for `process.on('SIGTERM'`; confirm presence.
  - **A23**: show the new batch loop in `coinmarketcap-provider.ts` and the new test result.
- Vitest output: all tests passing (count should be ~301 + however many new ones; net should not decrease).
- Doc-fix pile items added in retrofit-1:
  - `Neonfi Database Schema.docx`: add `Transaction.status` field OR mark the architecture rep's status enum as post-MVP. Schema-vs-architecture defect.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
