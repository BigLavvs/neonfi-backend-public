// Neonfi backend — single shared Redis client (Build Guide §1.1 / §3.4).
//
// One ioredis connection per process, imported everywhere. NEVER construct a new
// Redis connection in a handler/service/job — redundant sockets under load
// undermine the <50k-concurrent-user target. lazyConnect is left false so
// connection attempts begin immediately and failures surface at startup rather
// than on first use. Redis is the self-hosted Coolify container reached over the
// internal Docker network (REDIS_URL) — never a public host.

import { Redis } from 'ioredis';
import { config } from './config.js';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

// When NODE_ENV=test, config.ts has already required REDIS_URL_TEST and verified
// it does not target the runtime Redis database.
const redisUrl = config.NODE_ENV === 'test' ? config.REDIS_URL_TEST! : config.REDIS_URL;

export const redis: Redis =
  globalForRedis.redis ??
  new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });

// Surface connection problems in logs without crashing the process; /health is
// the authoritative up/down signal for orchestration.
redis.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error(`[redis] connection error: ${err.message}`);
});

if (config.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

// Non-blocking key enumeration (audit SEC/perf #5). `KEYS` is O(keyspace) and blocks the
// single-threaded Redis server for the whole scan — on a hot instance that stalls the price
// firehose, ws-auth and derive reads. SCAN walks the keyspace in bounded cursor steps so other
// commands interleave. Use this everywhere instead of `redis.keys(pattern)`.
// NOTE: SCAN may return duplicates across cursor steps — callers that delete are fine (idempotent),
// and we de-dupe via a Set so the returned list is unique.
export async function scanKeys(pattern: string, count = 250): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const k of batch) found.add(k);
  } while (cursor !== '0');
  return [...found];
}
