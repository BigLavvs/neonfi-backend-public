// Account-lockout helpers (Build Guide §6.9 / Appendix item 10; audit SEC per-IP dimension).
//
// State lives in Redis only — no DB writes.
// Key: `lockout:login:<subject>` → integer counter, where <subject> is one of:
//   - emailIpSubject(email, ip) → `<lowercased-email>|<ip>` — per (account, IP). Caps brute force
//     on ONE account WITHOUT letting an attacker lock the victim out from a different IP (so the
//     per-email lockout can't be weaponized as a targeted DoS).
//   - ipSubject(ip)            → `ip|<ip>`                 — per IP across all accounts; catches one
//     IP spraying many accounts.
// TTL is AUTH_LOGIN_LOCKOUT_MS, set on the FIRST failure and NOT extended on subsequent failures
// within the same window (expires from the first bad attempt — a deliberate MVP choice).

import { redis } from './redis.js';
import { config } from './config.js';

function key(subject: string): string {
  return `lockout:login:${subject}`;
}

export function emailIpSubject(email: string, ip: string | null): string {
  return `${email.toLowerCase()}|${ip ?? 'unknown'}`;
}

export function ipSubject(ip: string | null): string {
  return `ip|${ip ?? 'unknown'}`;
}

/** Increment the failure counter for `subject`; sets TTL on first failure. Returns the new count. */
export async function recordFailedLogin(subject: string): Promise<number> {
  const k = key(subject);
  const count = await redis.incr(k);
  if (count === 1) {
    // First failure — set the lockout window starting now.
    await redis.pexpire(k, config.AUTH_LOGIN_LOCKOUT_MS);
  }
  return count;
}

export async function clearLockout(subject: string): Promise<void> {
  await redis.del(key(subject));
}

export interface LockoutState {
  locked: boolean;
  count: number;
  /** Remaining lockout time in milliseconds (0 if not locked or TTL unknown). */
  ttlMs: number;
}

export async function getLockoutState(
  subject: string,
  maxAttempts: number = config.AUTH_LOGIN_MAX_ATTEMPTS,
): Promise<LockoutState> {
  const k = key(subject);
  const results = await redis.pipeline().get(k).pttl(k).exec();

  const countRaw = results?.[0]?.[1];
  const ttlRaw = results?.[1]?.[1];

  const count = typeof countRaw === 'string' ? parseInt(countRaw, 10) : 0;
  const ttlMs = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : 0;

  return {
    locked: count >= maxAttempts,
    count,
    ttlMs,
  };
}
