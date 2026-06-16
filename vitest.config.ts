import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each integration test hits the live DB + Redis — allow 30s per test
    // to account for Neon cold-start latency.
    testTimeout: 60000,
    hookTimeout: 30000,
    // Tests share a single dev DB + Redis instance. Run ALL test files
    // sequentially so each file's beforeEach truncations don't race with
    // another file's test setup.
    //
    // fileParallelism:false alone still let separate worker processes overlap
    // enough to race on the shared DB (one file's truncateAllUserData() wiping
    // a row another file is mid-test on). Force a SINGLE fork so every file runs
    // strictly sequentially against one Prisma client/connection (retrofit-23).
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { sequential: true },
  },
});
