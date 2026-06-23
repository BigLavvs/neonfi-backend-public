// Neonfi backend — health probe service (Build Guide §3.5, §6.4/§6.8).
//
// Checks DB (Prisma `SELECT 1`), Redis (`PING`), and Coinbase WS liveness
// within a short timeout. Coinbase is a state read (no network call);
// DB and Redis use Promise.race against TIMEOUT_MS.
//
// Route handler (src/app.ts) calls this; shapes the response envelope.

import { prisma } from './prisma.js';
import { redis } from './redis.js';
import { coinbase } from './coinbase.js';

const TIMEOUT_MS = 1500;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    ),
  ]);
}

export interface HealthResult {
  ok: boolean;
  db: 'up' | 'down';
  redis: 'up' | 'down';
  coinbase: 'up' | 'down';
  /** Generic, non-sensitive reason naming which dependency failed (no stack). */
  failure?: string;
}

export async function checkHealth(): Promise<HealthResult> {
  let db: 'up' | 'down' = 'down';
  let redisStatus: 'up' | 'down' = 'down';

  const [dbResult, redisResult] = await Promise.allSettled([
    withTimeout(prisma.$queryRaw`SELECT 1`, 'database'),
    withTimeout(redis.ping(), 'redis'),
  ]);

  if (dbResult.status === 'fulfilled') db = 'up';
  if (redisResult.status === 'fulfilled') redisStatus = 'up';

  // Coinbase check is a cheap state read — no network round-trip
  const coinbaseStatus: 'up' | 'down' = coinbase.isConnected() ? 'up' : 'down';

  // Coinbase is informational — a transient WS reconnect must not 503 the whole app.
  const ok = db === 'up' && redisStatus === 'up';
  let failure: string | undefined;
  if (!ok) {
    const down = [db === 'down' && 'database', redisStatus === 'down' && 'redis'].filter(
      Boolean,
    ) as string[];
    failure = `${down.join(' and ')} unavailable`;
  }

  return { ok, db, redis: redisStatus, coinbase: coinbaseStatus, failure };
}
