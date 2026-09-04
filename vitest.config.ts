import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests use an isolated test database and Redis target. The
    // config loader refuses to boot tests without DATABASE_URL_TEST and
    // REDIS_URL_TEST, or when they resolve to the runtime targets.
    testTimeout: 60000,
    hookTimeout: 30000,
    // Tests share one isolated test DB + Redis target. Run all files
    // sequentially so each file's cleanup cannot race another file's setup.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { sequential: true },
  },
});
