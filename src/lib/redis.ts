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

export const redis: Redis =
  globalForRedis.redis ??
  new Redis(config.REDIS_URL, {
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
