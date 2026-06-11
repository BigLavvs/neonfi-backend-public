// Neonfi backend — Auth module integration tests (Stage 1A).
//
// Strategy: option (b) — dev DB + Redis with per-test cleanup.
// beforeEach truncates `session` and `user` tables and removes all
// auth-related Redis keys. Lookup tables (auth_provider, onboarding_status,
// etc.) are seeded once at DB setup and are never modified by these tests.
//
// Uses Hono's app.request() for in-process HTTP — no real TCP server needed.

import { describe, it, beforeEach, expect } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = '/api/v1/auth';

async function post(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieValue(res: Response, name: string): string | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function cookieMaxAge(res: Response, name: string): number | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    if (!header.startsWith(`${name}=`)) continue;
    const m = /Max-Age=(\d+)/i.exec(header);
    return m ? parseInt(m[1]!, 10) : undefined;
  }
  return undefined;
}

async function clearRedisAuthKeys(): Promise<void> {
  const patterns = ['email_verify:*', 'lockout:login:*', 'resend_verify:*'];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(keys);
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_EMAIL = 'integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Integration User';

async function registerTestUser(): Promise<Response> {
  return post('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });
}

async function loginTestUser(): Promise<Response> {
  return post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Delete in FK-safe order: session → user (lookup tables left intact)
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 1. Register — happy path
// ---------------------------------------------------------------------------

it('1: register creates user with correct fields and pending_verification status', async () => {
  const res = await registerTestUser();
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.email).toBe(TEST_EMAIL);
  expect(json.data.user.fullName).toBe(TEST_FULL_NAME);
  expect(json.data.user.authProvider).toBe('email');
  expect(json.data.user.emailVerified).toBe(false);
  expect(json.data.user.onboardingStatus).toBe('pending_verification');
  expect(json.data.user).not.toHaveProperty('passwordHash');
  expect(json.data.user).not.toHaveProperty('newsletterSubscribed');

  // Verify DB row
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt shape
  expect(dbUser.fullName).toBe(TEST_FULL_NAME);

  // No session cookie — user must verify email first
  expect(cookieValue(res, 'session')).toBeUndefined();
  expect(cookieValue(res, 'refresh')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 2. Register — duplicate email
// ---------------------------------------------------------------------------

it('2: register with duplicate email returns 409 EMAIL_ALREADY_REGISTERED', async () => {
  await registerTestUser();
  const res = await registerTestUser();
  expect(res.status).toBe(409);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('EMAIL_ALREADY_REGISTERED');
});

// ---------------------------------------------------------------------------
// 3. Register — weak password
// ---------------------------------------------------------------------------

it('3: register with weak password returns 400 WEAK_PASSWORD', async () => {
  const res = await post('/register', {
    email: TEST_EMAIL,
    password: 'short1', // only 6 chars
    fullName: TEST_FULL_NAME,
  });
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('WEAK_PASSWORD');
});

// ---------------------------------------------------------------------------
// 4. Login — happy path: cookies set, Session row created
// ---------------------------------------------------------------------------

it('4: login with correct password sets cookies and creates Session row', async () => {
  await registerTestUser();
  const res = await loginTestUser();
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.email).toBe(TEST_EMAIL);

  const sessionCookie = cookieValue(res, 'session');
  const refreshCookie = cookieValue(res, 'refresh');
  expect(sessionCookie).toBeTruthy();
  expect(refreshCookie).toBeTruthy();

  // Verify Session row in DB
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const sessions = await prisma.session.findMany({ where: { userId: dbUser.id } });
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.refreshTokenHash).toHaveLength(64); // SHA-256 hex
  expect(sessions[0]!.revokedAt).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. Login — wrong password: 401, no session, lockout incremented
// ---------------------------------------------------------------------------

it('5: login with wrong password returns 401 and increments lockout counter', async () => {
  await registerTestUser();
  const res = await post('/login', { email: TEST_EMAIL, password: 'WrongPass1' });
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_CREDENTIALS');

  // No session created
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const sessions = await prisma.session.findMany({ where: { userId: dbUser.id } });
  expect(sessions).toHaveLength(0);

  // Lockout counter incremented
  const count = await redis.get(`lockout:login:${TEST_EMAIL}`);
  expect(parseInt(count ?? '0', 10)).toBe(1);
});

// ---------------------------------------------------------------------------
// 6. Login — 5 wrong attempts → 6th returns 423 ACCOUNT_LOCKED
// ---------------------------------------------------------------------------

it('6: 5 wrong logins trigger lockout; 6th attempt returns 423 ACCOUNT_LOCKED', async () => {
  await registerTestUser();
  // 5 failed attempts
  for (let i = 0; i < 5; i++) {
    await post('/login', { email: TEST_EMAIL, password: 'WrongPass1' });
  }
  const res = await post('/login', { email: TEST_EMAIL, password: 'WrongPass1' });
  expect(res.status).toBe(423);
  const json = await res.json() as { error: { code: string }; meta: { retryAfterMs: number } };
  expect(json.error.code).toBe('ACCOUNT_LOCKED');
  expect(json.meta.retryAfterMs).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 7. Login — correct password clears lockout counter
// ---------------------------------------------------------------------------

it('7: successful login clears the lockout counter', async () => {
  await registerTestUser();
  // 2 failed attempts to build up the counter
  await post('/login', { email: TEST_EMAIL, password: 'WrongPass1' });
  await post('/login', { email: TEST_EMAIL, password: 'WrongPass1' });

  // Verify counter is 2
  const before = await redis.get(`lockout:login:${TEST_EMAIL}`);
  expect(parseInt(before ?? '0', 10)).toBe(2);

  // Successful login clears it
  const res = await loginTestUser();
  expect(res.status).toBe(200);

  const after = await redis.get(`lockout:login:${TEST_EMAIL}`);
  expect(after).toBeNull();
});

// ---------------------------------------------------------------------------
// 8. Logout — Session.revokedAt set; cookies cleared
// ---------------------------------------------------------------------------

it('8: logout sets Session.revokedAt and clears cookies', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;

  const res = await post('/logout', {}, `session=${sessionCookie}`);
  expect(res.status).toBe(200);

  // Session.revokedAt is now set
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const sessions = await prisma.session.findMany({ where: { userId: dbUser.id } });
  expect(sessions[0]!.revokedAt).not.toBeNull();

  // Cookies cleared — Max-Age = 0
  const sessionMaxAge = cookieMaxAge(res, 'session');
  const refreshMaxAge = cookieMaxAge(res, 'refresh');
  expect(sessionMaxAge).toBe(0);
  expect(refreshMaxAge).toBe(0);
});

// ---------------------------------------------------------------------------
// 9. Verify-email — valid token transitions to verified
// ---------------------------------------------------------------------------

it('9: verify-email with valid token transitions onboardingStatus to verified', async () => {
  await registerTestUser();

  // Grab the token from Redis
  const keys = await redis.keys('email_verify:*');
  expect(keys).toHaveLength(1);
  const token = keys[0]!.replace('email_verify:', '');

  const res = await post('/verify-email', { token });
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user?: Record<string, unknown>; alreadyVerified?: boolean } };
  if ('user' in json.data) {
    expect(json.data.user!.onboardingStatus).toBe('verified');
    expect(json.data.user!.emailVerified).toBe(true);
  } else {
    expect(json.data.alreadyVerified).toBe(true);
  }

  // Token consumed — key deleted from Redis
  const afterKeys = await redis.keys('email_verify:*');
  expect(afterKeys).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 10. Verify-email — stale/missing token returns 400
// ---------------------------------------------------------------------------

it('10: verify-email with invalid token returns 400 INVALID_VERIFICATION_TOKEN', async () => {
  const res = await post('/verify-email', { token: 'notarealtoken' });
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_VERIFICATION_TOKEN');
});

// ---------------------------------------------------------------------------
// 11. Refresh — new session cookie issued; refresh cookie unchanged
// ---------------------------------------------------------------------------

it('11: refresh with valid refresh cookie issues a new session cookie', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const originalSession = cookieValue(loginRes, 'session')!;
  const refreshCookie = cookieValue(loginRes, 'refresh')!;

  const res = await post('/refresh', {}, `refresh=${refreshCookie}`);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { ok: boolean } };
  expect(json.data.ok).toBe(true);

  // New session cookie is present and different from original
  const newSession = cookieValue(res, 'session');
  expect(newSession).toBeTruthy();
  expect(newSession).not.toBe(originalSession);

  // Refresh cookie is NOT in the Set-Cookie response (non-rotating §1.6)
  const refreshInResponse = cookieValue(res, 'refresh');
  expect(refreshInResponse).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 12. Refresh — revoked session returns 401 SESSION_EXPIRED
// ---------------------------------------------------------------------------

it('12: refresh with a revoked session returns 401 SESSION_EXPIRED', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;
  const refreshCookie = cookieValue(loginRes, 'refresh')!;

  // Revoke the session via logout
  await post('/logout', {}, `session=${sessionCookie}`);

  const res = await post('/refresh', {}, `refresh=${refreshCookie}`);
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('SESSION_EXPIRED');
});
