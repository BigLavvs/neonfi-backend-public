// Neonfi backend — CSRF protection (audit SEC, decision 7).
//
// The API authenticates with cookies (session/refresh), so it is exposed to cross-site request
// forgery: a malicious page could trigger a state-changing request that rides the victim's ambient
// cookies. Browsers ALWAYS attach an Origin header to cross-origin state-changing fetches/forms, so
// an allowlist check on Origin (with Referer fallback) blocks the browser CSRF vector with zero
// client changes. Requests with no Origin/Referer are not browser-initiated cross-site requests
// (server-to-server, curl, native apps) and are allowed.
//
// Only mutating methods are guarded. Signature-verified webhooks (Stripe/Moralis) are skipped.
// Disabled when NODE_ENV=test or CSRF_ENABLED=false.

import type { Context, MiddlewareHandler } from 'hono';
import { err } from './envelope.js';
import { config, isTest } from './config.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildAllowlist(): Set<string> {
  const extra = (config.CSRF_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origins = [config.APP_BASE_URL, config.API_BASE_URL, ...extra]
    .map(originOf)
    .filter((o): o is string => o !== null);
  return new Set(origins);
}

export interface CsrfOptions {
  skip?: (c: Context) => boolean;
}

export function csrfProtection(opts?: CsrfOptions): MiddlewareHandler {
  const allowed = buildAllowlist();
  return async (c, next) => {
    if (isTest || !config.CSRF_ENABLED) return next();
    if (!MUTATING.has(c.req.method)) return next();
    if (opts?.skip && opts.skip(c)) return next();

    const origin = c.req.header('origin');
    if (origin) {
      if (!allowed.has(origin)) {
        return c.json(err('CSRF_FORBIDDEN', 'Cross-origin request blocked'), 403);
      }
      return next();
    }

    const referer = c.req.header('referer');
    if (referer) {
      const refOrigin = originOf(referer);
      if (!refOrigin || !allowed.has(refOrigin)) {
        return c.json(err('CSRF_FORBIDDEN', 'Cross-origin request blocked'), 403);
      }
      return next();
    }

    // No Origin/Referer → not a browser cross-site request. Allow.
    return next();
  };
}
