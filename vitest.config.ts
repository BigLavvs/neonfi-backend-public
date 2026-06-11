import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each integration test hits the live DB + Redis — allow 30s per test
    // to account for Neon cold-start latency.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Single file runs sequentially by default; explicit for clarity.
    sequence: { sequential: true },
  },
});
