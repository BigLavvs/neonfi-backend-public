// Cookie helpers for the two-cookie session model (stage-1a.md §1.1).
//
// `session`  — HttpOnly, SameSite=Lax, short-lived JWT access token.
//              Cookie name is HARDCODED by the frontend (hooks.server.ts:30).
//              Do not rename.
// `refresh`  — HttpOnly, SameSite=Lax, opaque random refresh token.
//
// SameSite=Lax (not Strict) is required so the session survives a return trip
// from an external top-level navigation (OAuth / Stripe Checkout): Strict
// cookies are withheld on the request following a cross-site top-level
// navigation, so the user would appear logged out on return. Lax is still NOT
// sent on cross-site POST/subresource requests, preserving CSRF protection.
//
// Secure flag is set only in production — dev frontend runs on http://localhost
// and Secure on http breaks the cookie.  No Domain attribute: origin-scoped is
// correct (api.neonfi.live sends to neonfi.live on credentials:'include').

import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { isProduction, config } from './config.js';
import { parseDurationToSeconds } from './duration.js';

const BASE_OPTS = {
  httpOnly: true as const,
  sameSite: 'Lax' as const,
  path: '/',
} as const;

export function setSessionCookie(c: Context, jwt: string): void {
  setCookie(c, 'session', jwt, {
    ...BASE_OPTS,
    secure: isProduction,
    maxAge: parseDurationToSeconds(config.ACCESS_TOKEN_EXPIRY),
  });
}

export function setRefreshCookie(c: Context, refreshToken: string): void {
  setCookie(c, 'refresh', refreshToken, {
    ...BASE_OPTS,
    secure: isProduction,
    maxAge: parseDurationToSeconds(config.REFRESH_TOKEN_EXPIRY),
  });
}

export function clearAuthCookies(c: Context): void {
  deleteCookie(c, 'session', { path: '/' });
  deleteCookie(c, 'refresh', { path: '/' });
}
