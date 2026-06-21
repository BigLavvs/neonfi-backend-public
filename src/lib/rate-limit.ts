// Neonfi backend — global IP rate limiting (audit SEC #27).
//
// A Redis sliding-window-log limiter mounted as Hono middleware in app.ts. There was
// previously NO IP/global throttle anywhere, so register/login/password-reset/verify-email/
// refresh were brute-forceable and DoS-able. This adds per-IP buckets:
//   - GLOBAL    on every API route except the signature-verified webhooks
//   - AUTH      tighter, on /auth/*
//   - SENSITIVE tighter still, on provider-fanout (/portfolios/wallet/preview) + /subscriptions/refund
//
// Design notes:
//   - Sliding window via a Redis sorted set: drop entries older than the window, add this
//     hit, count, set TTL. One pipeline round-trip per request.
//   - FAIL-OPEN: a Redis error must never lock every user out, so on error we allow the request.
//   - Disabled when NODE_ENV=test (the integration suite fires many rapid requests) or when
//     RATE_LIMIT_ENABLED=false.

import type { Context, MiddlewareHandler } from 'hono';
import { redis } from './redis.js';
import { err } from './envelope.js';
import { config, isTest } from './config.js';

export interface RateLimitOptions {
  // Bucket id — keeps the GLOBAL/AUTH/SENSITIVE counters separate per IP.
  id: string;
  limit: number;
  windowMs: number;
  // Optional predicate to skip limiting for a request (e.g. signature-verified webhooks).
  skip?: (c: Context) => boolean;
}

// Trusted client IP. Behind a single trusted reverse proxy (nginx/Coolify), the client can
// spoof the LEFT-most X-Forwarded-For entry, but the proxy APPENDS the real connecting IP, so
// the RIGHT-most entry is trustworthy. Prefer it; fall back to x-real-ip, then the raw socket.
export function trustedClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  const real = c.req.header('x-real-ip');
  if (real && real.trim()) return real.trim();
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    if (isTest || !config.RATE_LIMIT_ENABLED) return next();
    if (opts.skip && opts.skip(c)) return next();

    const ip = trustedClientIp(c);
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const key = `ratelimit:${opts.id}:${ip}`;
    // Member must be unique per hit so two requests in the same ms both count.
    const member = `${now}:${Math.floor(Math.random() * 1e9)}`;

    let count: number;
    try {
      const res = await redis
        .pipeline()
        .zremrangebyscore(key, 0, windowStart)
        .zadd(key, now, member)
        .zcard(key)
        .pexpire(key, opts.windowMs)
        .exec();
      // exec() → [[err, result], ...]; zcard is the 3rd command (index 2).
      count = res && res[2] && res[2][1] != null ? Number(res[2][1]) : 0;
    } catch (e) {
      // Fail OPEN — a Redis blip must not 429 everyone.
      console.error('[rate-limit] redis error, failing open', (e as Error).message);
      return next();
    }

    if (count > opts.limit) {
      const retryAfter = Math.ceil(opts.windowMs / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        err('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', { retryAfter }),
        429,
      );
    }

    return next();
  };
}
