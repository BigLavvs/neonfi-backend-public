// Neonfi backend — Auth module: route controller (Stage 1A).
//
// Controllers are thin: parse + validate input, call service, return envelope.
// No DB queries here; no business logic here.
//
// Mounted at /api/v1/auth by src/index.ts.
//
// Endpoints in this file (Stage 1A — 6 of 10 total auth endpoints):
//   POST /auth/register
//   POST /auth/login
//   POST /auth/logout        (idempotent — clears cookies regardless of session state)
//   POST /auth/verify-email
//   POST /auth/resend-verification
//   POST /auth/refresh

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { validator } from 'hono/validator';
import { ok, err } from '../../lib/envelope.js';
import { setSessionCookie, setRefreshCookie, clearAuthCookies } from '../../lib/cookies.js';
import type { AuthEnv } from './middleware.js';
import {
  AuthError,
  register,
  login,
  logout,
  verifyEmail,
  resendVerification,
  refresh,
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

export { router as authRouter };
