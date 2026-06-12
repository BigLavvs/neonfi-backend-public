// Neonfi backend — shared test helpers (Stages 2+).
//
// Pure utilities that are needed across multiple test files. HTTP helpers
// (post/get/del/patch) live per-file because their BASE URL differs.

import { redis } from '../src/lib/redis.js';

export function cookieValue(res: Response, name: string): string | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function cookieMaxAge(res: Response, name: string): number | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    if (!header.startsWith(`${name}=`)) continue;
    const m = /Max-Age=(\d+)/i.exec(header);
    return m ? parseInt(m[1]!, 10) : undefined;
  }
  return undefined;
}

export async function clearRedisAuthKeys(): Promise<void> {
  const patterns = [
    'email_verify:*',
    'lockout:login:*',
    'resend_verify:*',
    'ws_ticket:*',
    'oauth_state:*',
  ];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(keys);
  }
}
