// Neonfi backend — single shared Prisma client (Build Guide §1.1 / §3.4).
//
// The Prisma client is instantiated ONCE per process and imported everywhere.
// NEVER construct `new PrismaClient()` anywhere else — per-request instantiation
// exhausts the Neon connection pool. The global-singleton pattern below survives
// hot-reload in dev (tsx watch) so repeated module evaluation does not spawn
// multiple clients.
//
// retrofit-17: the base client is wrapped in a Prisma 6 `$extends` query
// extension that RETRIES only transient connection-ESTABLISHMENT errors — Neon's
// free-tier compute scale-to-zero (5-min idle auto-suspend, not configurable on
// free) leaves pooled connections dead, so the first query after an idle period
// throws P1001 ("can't reach database server") or P1017 ("server closed the
// connection") while the compute cold-starts. Those two are safe to retry: the
// query never executed. Everything else — query/constraint/validation errors and
// mid-transaction failures (which already touched the DB) — is rethrown
// immediately, never retried. See `RETRYABLE_CONNECTION_CODES` below.

import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

// --- Transient-connection retry (retrofit-17 Part 2) -------------------------
// ONLY connection-establishment errors. P1001 surfaces on PrismaClientInitializationError
// (`.errorCode`); P1017 on PrismaClientKnownRequestError (`.code`) — we read both.
export const RETRYABLE_CONNECTION_CODES = new Set(['P1001', 'P1017']);

const MAX_ATTEMPTS = 4;
// Backoff between attempts (not before the first try): ~3.75s total worst case
// before the final attempt — comfortably inside a 30s connect_timeout wake.
const BACKOFF_MS: readonly number[] = [250, 1000, 2500];

export function isRetryableConnectionError(e: unknown): boolean {
  const code =
    (e as { code?: string })?.code ?? (e as { errorCode?: string })?.errorCode;
  return typeof code === 'string' && RETRYABLE_CONNECTION_CODES.has(code);
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `op`, retrying ONLY transient connection errors (P1001/P1017) with capped
 * backoff. Any non-retryable error throws on the first occurrence. Exported so
 * the unit test can drive it with an injected (instant) delay.
 */
export async function withConnectionRetry<T>(
  op: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    backoffMs?: readonly number[];
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? BACKOFF_MS;
  const delay = opts.delay ?? defaultDelay;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (!isRetryableConnectionError(e) || attempt === maxAttempts - 1) throw e;
      await delay(backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 2500);
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the compiler.
  throw lastErr;
}

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

// When NODE_ENV=test, config.ts has already required DATABASE_URL_TEST and
// verified it does not target the runtime database.
const testDbUrl = config.NODE_ENV === 'test' ? config.DATABASE_URL_TEST : undefined;

// The SINGLE `new PrismaClient(...)` in the codebase (check-singletons.mjs guards
// this). Datasources + log preserved exactly; the retry extension wraps THIS base.
function createBaseClient(): PrismaClient {
  return new PrismaClient({
    datasources: testDbUrl ? { db: { url: testDbUrl } } : undefined,
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

// `$allOperations` wraps every model + raw operation (including $queryRaw used by
// the keep-alive). It does NOT wrap the per-statement ops inside an interactive
// `$transaction(async (tx) => …)` — those run on the base tx client — so a
// mid-transaction connection drop is never silently retried (desired).
function withRetryExtension(base: PrismaClient) {
  return base.$extends({
    query: {
      $allOperations({ args, query }) {
        return withConnectionRetry(() => query(args));
      },
    },
  });
}

// The exported type is the EXTENDED client, not PrismaClient. A query-only
// extension preserves all model delegates and `$transaction`/`$queryRaw`/etc.,
// so every existing `import { prisma }` site keeps compiling.
export type ExtendedPrismaClient = ReturnType<typeof withRetryExtension>;

// The interactive-transaction client type for the EXTENDED client. A Prisma
// `$extends` rewrites the `$transaction(async (tx) => …)` callback param into the
// dynamic-extension shape, which is NOT assignable to `Prisma.TransactionClient`
// (DefaultArgs vs the extension's InternalArgs differ in the model-arg generics).
// So helper signatures that thread a tx through must type it as THIS — derived from
// the extended client by omitting the methods Prisma forbids inside a transaction
// (the ITXClientDenyList: lifecycle, $on, nested $transaction, $use, $extends).
export type PrismaTransactionClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export const prisma: ExtendedPrismaClient =
  globalForPrisma.prisma ?? withRetryExtension(createBaseClient());

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
