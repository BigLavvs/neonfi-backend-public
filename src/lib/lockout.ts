// Account-lockout helpers (Build Guide §6.9 / Appendix item 10).
//
// State lives in Redis only — no DB writes.
// Key: `lockout:login:<lowercased-email>` → integer counter.
// TTL is AUTH_LOGIN_LOCKOUT_MS (milliseconds), set on the FIRST failure and
// NOT extended on subsequent failures within the same window.  This means the
// lockout expires from the first bad attempt, not the most recent one — a
// deliberate MVP choice; rotation can be added later.

import { redis } from './redis.js';
import { config } from './config.js';

function key(email: string): string {
  return `lockout:login:${email.toLowerCase()}`;
}

/** Increment the failure counter; sets TTL on first failure.  Returns the new count. */
export async function recordFailedLogin(email: string): Promise<number> {
  const k = key(email);
  const count = await redis.incr(k);
  if (count === 1) {
    // First failure — set the lockout window starting now.
    await redis.pexpire(k, config.AUTH_LOGIN_LOCKOUT_MS);
  }
  return count;
}

export async function clearLockout(email: string): Promise<void> {
  await redis.del(key(email));
}

export interface LockoutState {
  locked: boolean;
  count: number;
  /** Remaining lockout time in milliseconds (0 if not locked or TTL unknown). */
  ttlMs: number;
}

export async function getLockoutState(email: string): Promise<LockoutState> {
  const k = key(email);
  const results = await redis.pipeline().get(k).pttl(k).exec();

  const countRaw = results?.[0]?.[1];
  const ttlRaw = results?.[1]?.[1];

  const count = typeof countRaw === 'string' ? parseInt(countRaw, 10) : 0;
  const ttlMs = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : 0;

  return {
    locked: count >= config.AUTH_LOGIN_MAX_ATTEMPTS,
    count,
    ttlMs,
  };
}
