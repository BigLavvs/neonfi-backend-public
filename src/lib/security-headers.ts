// Neonfi backend — security response headers (audit SEC, decision 7).
//
// The repo previously set no security headers. This middleware adds them to every response.
// The backend is a JSON API (it never serves HTML or scripts), so the CSP is locked all the way
// down to `default-src 'none'` — nothing should ever be loaded from an API response — plus
// `frame-ancestors 'none'` / X-Frame-Options: DENY (clickjacking) and nosniff (MIME sniffing).
// HSTS is production-only (it only makes sense over HTTPS and would be wrong on a local http host).
//
// NOTE: the img-src/connect-src allowlist (images.neonfi.live, Stripe, Moralis/IPFS) belongs on
// the SvelteKit FRONTEND CSP (kit.csp), which is what actually renders HTML and loads those
// resources — that is a separate follow-up.

import type { MiddlewareHandler } from 'hono';
import { isProduction } from './config.js';

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (isProduction) {
      // 180 days; includeSubDomains. Only over HTTPS (production).
      c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  };
}
