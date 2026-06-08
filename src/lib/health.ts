// Neonfi backend — health probe service (Build Guide §3.5, §6.4/§6.8).
//
// Checks DB (Prisma `SELECT 1`) and Redis (`PING`) within a short timeout. The
// route handler (src/index.ts) is a controller only — it calls this service and
// shapes the envelope; the actual client access lives here.
//
// Coinbase WS is deliberately NOT checked here. The architecture's GET /health
// also covers Coinbase, but that connection does not exist until Stage 10; the
// Coinbase check is added to /ws/health (Stage 10, §6.4) when the WS server
// lands, and folded in here at that time. Until then this probe reflects only
// the dependencies Part 1 actually owns: DB + Redis.

import { prisma } from './prisma.js';
import { redis } from './redis.js';

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

  const ok = db === 'up' && redisStatus === 'up';
  let failure: string | undefined;
  if (!ok) {
    if (db === 'down' && redisStatus === 'down') failure = 'database and redis unavailable';
    else if (db === 'down') failure = 'database unavailable';
    else failure = 'redis unavailable';
  }

  return { ok, db, redis: redisStatus, failure };
}
