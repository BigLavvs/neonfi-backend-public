# retrofit-17: harden the Neon connection (stop the `kind: Closed` / P1001 flakiness)

## Root cause (not our query code)
The dev/prod DB is a Neon **free-tier** compute in AWS **us-east-1**, hit from a high-latency
region. Two compounding causes:
1. **Neon free-tier scale-to-zero**: the compute auto-suspends after **5 min idle** and this is
   **not configurable on free** (only paid Launch+ can disable it — verified against Neon docs).
   The first query after suspend must cold-start the compute, and Prisma's pooled connections that
   were open come back dead → `Error { kind: Closed }` (Prisma **P1017**, "server closed the
   connection") or **P1001** ("can't reach database server") while it wakes.
2. **Pooled URL misconfigured for Prisma**: `DATABASE_URL` uses the `-pooler` (PgBouncer) host but
   has **no `pgbouncer=true`** and **no `connect_timeout`**. Without `pgbouncer=true`, Prisma issues
   prepared statements that PgBouncer transaction-mode pooling breaks intermittently; without a
   `connect_timeout`, the first post-suspend query errors instead of waiting for the wake.

Grounding: `src/lib/prisma.ts:22-27` (single client, no params/retry), `prisma/schema.prisma`
datasource (`url=env("DATABASE_URL")` pooled, `directUrl=env("DIRECT_URL")`), Prisma **6.2.1**,
existing background jobs in `src/jobs/*.job.ts`.

The fix has three parts: a connection-string change (operator-applied), a transient-retry wrapper
(code), and an optional keep-alive (code, flagged).

---

## Part 1 — connection string params (operator applies to `.env`; CC must NOT write secrets)
**Do not edit `.env` in this retrofit** (it holds live credentials). Instead, document the change in
`.env.example` and the README, and tell the operator to append to the **pooled** `DATABASE_URL`
(leave `DIRECT_URL` untouched — migrations need a direct, non-pooled connection):

```
&pgbouncer=true&connect_timeout=30&pool_timeout=20
```

- `pgbouncer=true` — required for Prisma through Neon's PgBouncer pooler (disables prepared
  statements that pooling breaks). **Pooled URL only.**
- `connect_timeout=30` — wait up to 30s for a cold compute to wake instead of erroring immediately.
- `pool_timeout=20` — raise Prisma's 10s pool-wait so a brief wake doesn't trip a pool timeout.

Add to `.env.example` a commented note explaining each, and a README line that free-tier Neon
suspends after 5 min (so the first request after idle is slow but should no longer error).

---

## Part 2 — retry transient connection errors (the main code change)
Wrap the singleton in `src/lib/prisma.ts` with a Prisma client extension that retries **only
transient connection-establishment errors** — never query/constraint/validation errors, never
mid-transaction failures (those didn't reach or already touched the DB).

Retry triggers (safe — the query never executed):
- `PrismaClientInitializationError` with `errorCode === 'P1001'` (can't reach server)
- `PrismaClientKnownRequestError` with `code === 'P1017'` (server closed the connection)

Approach (Prisma 6 client extension):
```ts
const RETRYABLE = new Set(['P1001', 'P1017']);
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [250, 1000, 2500]; // between attempts; ~3.75s total worst case before the last try

function isRetryable(e: unknown): boolean {
  const code = (e as { code?: string; errorCode?: string })?.code
    ?? (e as { errorCode?: string })?.errorCode;
  return typeof code === 'string' && RETRYABLE.has(code);
}

const base = new PrismaClient({ /* existing datasources/log */ });

export const prisma = base.$extends({
  query: {
    async $allOperations({ args, query }) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          return await query(args);
        } catch (e) {
          lastErr = e;
          if (!isRetryable(e) || attempt === MAX_ATTEMPTS - 1) throw e;
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt] ?? 2500));
        }
      }
      throw lastErr;
    },
  },
});
```
Constraints:
- Preserve the existing `datasources` (test-DB override) and `log` config on the base client, and
  the `globalForPrisma` hot-reload singleton guard — wrap the SAME base instance.
- The exported type changes from `PrismaClient` to the extended client. Confirm every existing import
  of `prisma` still typechecks (extended clients keep all model delegates; `$transaction`, `$queryRaw`,
  etc. remain). Fix the exported type annotation if needed (`export const prisma: typeof base = ...`
  won't hold — let it infer, or export the extended type).
- Net effect: the first request after a 5-min idle now **waits + retries** through the wake instead
  of throwing `Closed`/P1001.

---

## Part 3 — keep-alive ping (OPTIONAL, config-gated, default OFF)
Eliminates even the slow-first-request after idle by preventing the compute from suspending while
the server runs. **Tradeoff:** this keeps the Neon compute awake continuously, which on free tier
**consumes compute-hours** and defeats scale-to-zero's savings — so default it OFF and let the
operator opt in for active dev. **For production, prefer keep-alive ON (or a paid plan with
scale-to-zero disabled): webhook handlers touch the DB, so a cold DB during an incoming webhook is a
reliability risk (Part 4) — keeping the compute warm removes the wake window entirely.**

- New `src/jobs/db-keepalive.job.ts`: `setInterval` every **4 min** running
  `await prisma.$queryRaw\`SELECT 1\`` (catch + log; never throw). Mirror the start/stop shape of
  `token-sync.job.ts` / `snapshot.job.ts`.
- New config flag `DB_KEEPALIVE_ENABLED` (zod, explicit `v === 'true'` transform — NOT
  `z.coerce.boolean`, same gotcha as `BINANCE_ENABLED`/`TOKEN_SYNC_ENABLED`; default `'false'`).
- Start it in `src/index.ts` behind the flag (after the DB is reachable), and clear the interval in
  the graceful-shutdown chain.

---

## Part 4 — make the Moralis webhook retry-safe under DB failure (the "missed webhook" risk)
The **Stripe** path is already safe: `webhooks.service.ts:74-84` returns **500** on any handler throw
and only sets the `stripe_event:<id>` idempotency key *after* a successful dispatch (line 92) — so a
DB error during a Neon wake makes Stripe retry, and the retry re-processes. No change there.

The **Moralis** path is NOT safe. In `moralis-handlers.ts`, per-transfer errors are caught and merely
counted as `skipped` (lines 462-495, plus the inner catches in `processNativeTx` /
`processErc20Transfer`), then the handler falls through to set the `moralis_event:<id>` key (line 503)
and return **200**. A transient connection error (Neon waking → P1001/P1017) thrown by
`findConnectedPortfolio` / `token.findFirst` / `createTransactionFromWebhook` is therefore swallowed
as a "skip," ACKed 200, and de-duped — so **Moralis never retries and the on-chain transfer is lost.**
That is the real missed-webhook case.

Fix: distinguish *expected business skips* (unknown chain, unknown token symbol, untracked wallet —
deterministic; retry won't help → ack 200 + dedupe) from *unexpected/transient errors* (DB
connection or anything unrecognised — retry WILL help → do NOT dedupe, return 500):
- Add a transient/unexpected detector (reuse the P1001/P1017 check from Part 2; treat any
  non-business exception as unexpected).
- In the per-transfer catch blocks, if the error is transient/unexpected, **re-throw** (or set a
  `hadUnexpectedError` flag) instead of `skipped++`. Keep counting genuine business skips as today.
- If `hadUnexpectedError`, **skip** `redis.set(moralis_event…)` and return
  `err('WEBHOOK_HANDLER_ERROR', …), 500` so Moralis retries. Only set the dedupe key + return 200 when
  every failure was an expected business skip.
- Note: with Part 2's retry extension in place, transient errors are usually retried away *before*
  reaching these catches — Part 4 is the backstop for when the DB is down longer than the retry window.

## Gates (tests)
1. **Retry unit test** (mock, no DB): a fake operation that throws `{ code: 'P1017' }` twice then
   resolves → the extension returns the value after retries; a fake op that throws `{ code: 'P2002' }`
   (unique constraint) → throws immediately, NO retry; a `P1001` initialization error → retried.
   (Inject a tiny backoff or fake timers so the test is fast.)
2. **Typecheck**: `tsc --noEmit` clean — every existing `import { prisma }` site still compiles with
   the extended client.
3. **No-regression**: with a healthy DB, one representative integration test (e.g. tokens or chains)
   still passes — the extension is a pass-through when nothing throws.
4. Singleton guard (`scripts/check-singletons.mjs`) still passes (still one `new PrismaClient`).
5. **Moralis retry-safety**: an unknown-token / untracked-wallet transfer → 200 + dedupe key set
   (expected skip, no retry wanted); a simulated transient DB error (P1017) inside a transfer →
   **500 and the `moralis_event:<id>` key is NOT set** (so Moralis retries). Extend
   `tests/moralis-webhook.test.ts`.

> Run gates with the dev server STOPPED (so it doesn't contend on the shared DB), and — until the
> operator applies the Part 1 `.env` params — you may still hit raw Neon flakiness; use the
> direct-endpoint + warm-loop recipe from memory to get a clean run.

## Commit (explicit add, no -A)
```bash
git add src/lib/prisma.ts \
        src/jobs/db-keepalive.job.ts src/lib/config.ts src/index.ts \
        src/modules/webhooks/moralis-handlers.ts \
        .env.example \
        tests/prisma-retry.test.ts tests/moralis-webhook.test.ts _claude/retrofit-17.md
git commit -m "fix(db): retry transient Neon connection errors (P1001/P1017) + optional keep-alive; document pgbouncer/connect_timeout (retrofit-17)"
```
Report: SHA, that the extended-client type compiles across all import sites, the retry codes +
attempt/backoff used, and whether keep-alive defaulted off.

## Notes
- The **highest-leverage, zero-code** part is the operator's `.env` change (Part 1) — that alone
  (`pgbouncer=true` + `connect_timeout=30`) removes most of the user-visible errors. Parts 2-3 make
  it robust.
- For a permanent end to cold starts (no keep-alive cost), the operator can move Neon to a paid plan
  (Launch lets you disable scale-to-zero) or a region closer to the user. Out of scope for code.
