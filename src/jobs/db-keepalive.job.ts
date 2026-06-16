// Neonfi backend — DB keep-alive ping (retrofit-17 Part 3, OPTIONAL/default OFF).
//
// Neon free-tier compute auto-suspends after 5 min idle (not configurable on
// free). The first query after suspend cold-starts the compute, so it's slow and
// — without the Part 1 connect_timeout — can error. Pinging `SELECT 1` every 4
// min (inside the 5-min window) keeps the compute awake while the server runs,
// eliminating the slow-first-request entirely.
//
// TRADEOFF: keeping the compute awake consumes free-tier compute-hours
// continuously and defeats scale-to-zero's savings. So this is gated behind
// DB_KEEPALIVE_ENABLED (default false) — the operator opts in for active dev.
//
// Mirrors the start/stop shape of token-sync.job.ts / snapshot.job.ts: a single
// exported start fn, gated by config, started only outside tests from src/index.ts.
// Uses setInterval (not node-cron) because a fixed sub-hour heartbeat is simpler
// as a plain interval. The ping NEVER throws: a failed ping is logged and the
// next tick retries (the retry extension in prisma.ts already handles P1001/P1017).

import { prisma } from '../lib/prisma.js';

// 4 minutes, comfortably inside Neon free-tier's 5-min idle-suspend window.
export const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

async function ping(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    // Never throw — a transient failure must not crash the process. The next
    // tick retries; the prisma.ts retry extension already absorbs P1001/P1017.
    console.error('[db-keepalive] ping failed:', e);
  }
}

export function startDbKeepalive(): void {
  if (timer) return; // idempotent — never stack intervals
  timer = setInterval(() => {
    void ping();
  }, KEEPALIVE_INTERVAL_MS);
  // Don't let the heartbeat keep the event loop alive on its own at shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[db-keepalive] started (every ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
}

export function stopDbKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[db-keepalive] stopped');
  }
}
