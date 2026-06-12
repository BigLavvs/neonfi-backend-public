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
    fileParallelism: false,
    sequence: { sequential: true },
  },
});
