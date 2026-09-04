// Neonfi backend — dedicated Redis subscriber connection.
//
// Redis SUBSCRIBE locks the connection to subscribe-mode, preventing normal
// commands. A second client is required so src/lib/redis.ts stays available
// for queries. Both clients are inside src/lib/ which check-singletons.mjs
// already excludes from the guard.

import { Redis } from 'ioredis';
import { config } from './config.js';

const redisUrl =
  config.NODE_ENV === 'test'
    ? config.REDIS_URL_TEST!
    : config.REDIS_URL;

export const redisSubscriber = new Redis(redisUrl, {
  lazyConnect: false,
});

redisSubscriber.on('error', (err: Error) => {
  console.error(`[redis-subscriber] connection error: ${err.message}`);
});
