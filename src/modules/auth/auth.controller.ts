// Neonfi backend — Auth module: route controller (Stages 1A + 1B).
//
// Controllers are thin: parse + validate input, call service, return envelope.
// No DB queries here; no business logic here.
//
// Mounted at /api/v1/auth by src/index.ts.
//
// Stage 1A (6 endpoints):
//   POST /auth/register, POST /auth/login, POST /auth/logout,
//   POST /auth/verify-email, POST /auth/resend-verification, POST /auth/refresh
//
// Stage 1B (4 endpoints — all 10 auth endpoints complete):
//   GET /auth/google, GET /auth/google/callback,
//   GET /auth/sessions, DELETE /auth/sessions/:id, GET /auth/ws-token

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { validator } from 'hono/validator';
import { ok, err } from '../../lib/envelope.js';
import { config, isProduction } from '../../lib/config.js';
import { setSessionCookie, setRefreshCookie, clearAuthCookies } from '../../lib/cookies.js';
import type { AuthEnv } from './middleware.js';
import { requireAuth } from './middleware.js';
import {
  AuthError,
  register,
  login,
  logout,
  verifyEmail,
  resendVerification,
  refresh,
  googleOAuthInit,
  handleGoogleCallback,
  listSessions,
  revokeSessionById,
  issueWsTicket,
} from './auth.service.js';
import {
  RegisterSchema,
  LoginSchema,
  VerifyEmailSchema,
  ResendVerificationSchema,
} from './auth.schemas.js';
import type { ZodSchema } from 'zod';

const router = new Hono<AuthEnv>();

// Structural type covering just the json() method we call from handleError.
// All Hono Context objects satisfy this; avoids fighting generic param inference.
type JsonCapable = { json(body: unknown, status?: number): Response };

// ---------------------------------------------------------------------------
// Validation helper — returns 400 WEAK_PASSWORD for password issues, else
// VALIDATION_ERROR, so controllers just chain .post('/path', validate(Schema)).
// ---------------------------------------------------------------------------

function validate(schema: ZodSchema) {
  return validator('json', (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      const isPasswordIssue = issue?.path.includes('password');
      const code = isPasswordIssue ? 'WEAK_PASSWORD' : 'VALIDATION_ERROR';
      const message = issue?.message ?? 'Validation failed';
      return c.json(err(code, message), 400);
    }
    return result.data;
  });
}

// ---------------------------------------------------------------------------
// Error helper — converts AuthError to the right HTTP response; re-throws
// anything else so the global error handler in index.ts can log it.
// ---------------------------------------------------------------------------

function handleError(e: unknown, c: JsonCapable): Response {
  if (e instanceof AuthError) {
    const body = e.meta
      ? { ...err(e.code, e.message), meta: e.meta }
      : err(e.code, e.message);
    return c.json(body, e.statusCode);
  }
  throw e;
}

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

router.post('/register', validate(RegisterSchema), async (c) => {
  try {
    const body = c.req.valid('json') as ReturnType<typeof RegisterSchema.parse>;
    const result = await register(body);
    return c.json(ok(result), 201);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

router.post('/login', validate(LoginSchema), async (c) => {
  try {
    const body = c.req.valid('json') as ReturnType<typeof LoginSchema.parse>;
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      null;
    const userAgent = c.req.header('user-agent') ?? null;

    const result = await login(body, ip, userAgent);
    setSessionCookie(c, result.accessToken);
    setRefreshCookie(c, result.refreshToken);
    return c.json(ok({ user: result.user }), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout — idempotent (§3.3): clear cookies regardless of auth state.
// The service does a best-effort session revocation; any failure is swallowed.
// "Auth required" in the spec means "reads the session cookie", not "401 on failure".
// ---------------------------------------------------------------------------

router.post('/logout', async (c) => {
  const sessionToken = getCookie(c, 'session') ?? null;
  await logout(sessionToken);
  clearAuthCookies(c);
  return c.json(ok({ ok: true }), 200);
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------

router.post('/verify-email', validate(VerifyEmailSchema), async (c) => {
  try {
    const body = c.req.valid('json') as ReturnType<typeof VerifyEmailSchema.parse>;
    const result = await verifyEmail(body);
    return c.json(ok(result), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/resend-verification
// ---------------------------------------------------------------------------

router.post('/resend-verification', validate(ResendVerificationSchema), async (c) => {
  try {
    const body = c.req.valid('json') as ReturnType<typeof ResendVerificationSchema.parse>;
    await resendVerification(body);
    return c.json(ok({ ok: true }), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh — reads `refresh` cookie, issues new `session` cookie.
// Refresh cookie is NOT replaced (non-rotating §1.6).
// ---------------------------------------------------------------------------

router.post('/refresh', async (c) => {
  const rawRefreshToken = getCookie(c, 'refresh');
  if (!rawRefreshToken) {
    return c.json(err('NO_REFRESH_TOKEN', 'No refresh token present'), 401);
  }
  try {
    const result = await refresh(rawRefreshToken);
    setSessionCookie(c, result.accessToken);
    return c.json(ok({ ok: true }), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeReturnTo(raw: string | undefined): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/') || raw.includes(':') || raw.includes('//')) return '/dashboard';
  return raw;
}

// ---------------------------------------------------------------------------
// GET /auth/google — initiate server-redirect OAuth flow
// ---------------------------------------------------------------------------

router.get('/google', async (c) => {
  const returnTo = sanitizeReturnTo(c.req.query('return_to'));
  const { authUrl, state } = await googleOAuthInit(returnTo);
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/api/v1/auth/google',
    secure: isProduction,
    maxAge: 600,
  });
  return c.redirect(authUrl, 302);
});

// ---------------------------------------------------------------------------
// GET /auth/google/callback — receive code from Google, create session
// ---------------------------------------------------------------------------

router.get('/google/callback', async (c) => {
  const errorQuery = c.req.query('error');
  const code = c.req.query('code');
  const queryState = c.req.query('state');
  const cookieState = getCookie(c, 'oauth_state');
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;

  // Always clear the oauth_state cookie (success or error path)
  deleteCookie(c, 'oauth_state', { path: '/api/v1/auth/google' });

  if (errorQuery) {
    return c.redirect(`${config.APP_BASE_URL}/register?oauth_error=access_denied`, 302);
  }

  const result = await handleGoogleCallback({ code, queryState, cookieState, ip, userAgent });

  if (!result.ok) {
    return c.redirect(`${config.APP_BASE_URL}/register?oauth_error=${result.reason}`, 302);
  }

  setSessionCookie(c, result.accessToken);
  setRefreshCookie(c, result.refreshToken);
  return c.redirect(`${config.APP_BASE_URL}${result.returnTo}`, 302);
});

// ---------------------------------------------------------------------------
// GET /auth/sessions — list caller's active sessions (requireAuth)
// ---------------------------------------------------------------------------

router.get('/sessions', requireAuth, async (c) => {
  const user = c.get('user');
  const session = c.get('session');
  const sessions = await listSessions(user.id, session.id);
  return c.json(ok({ sessions }, { total: sessions.length }), 200);
});

// ---------------------------------------------------------------------------
// DELETE /auth/sessions/:id — revoke a session (requireAuth)
// ---------------------------------------------------------------------------

router.delete('/sessions/:id', requireAuth, async (c) => {
  const idStr = c.req.param('id');
  const sessionId = parseInt(idStr, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json(err('VALIDATION_ERROR', 'Session ID must be a positive integer'), 400);
  }
  try {
    const currentUser = c.get('user');
    const currentSession = c.get('session');
    const result = await revokeSessionById(sessionId, currentUser.id, currentSession.id);
    if (result.loggedOut) clearAuthCookies(c);
    return c.json(ok({ ok: true, loggedOut: result.loggedOut }), 200);
  } catch (e) {
    return handleError(e, c);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/ws-token — issue single-use WS ticket (requireAuth, no plan check)
// ---------------------------------------------------------------------------

router.get('/ws-token', requireAuth, async (c) => {
  const user = c.get('user');
  const session = c.get('session');
  const result = await issueWsTicket(user.id, session.id);
  return c.json(ok({ token: result.token, expiresIn: 60 }), 200);
});

export { router as authRouter };
