// Neonfi backend — Auth module integration tests (Stage 1A).
//
// Strategy: isolated test DB + Redis with per-test cleanup.
// beforeEach truncates `session` and `user` tables and removes all
// auth-related Redis keys. Lookup tables (auth_provider, onboarding_status,
// etc.) are seeded once at DB setup and are never modified by these tests.
//
// Uses Hono's app.request() for in-process HTTP — no real TCP server needed.

import { describe, it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { sendPasswordResetEmail } from '../src/modules/email/email.service.js';
import { emailIpSubject } from '../src/lib/lockout.js';
import { cookieValue, cookieMaxAge, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Google OAuth mocks — hoisted so the factory runs before module loads
// ---------------------------------------------------------------------------
const { mockGenerateAuthUrl, mockGetToken, mockVerifyIdToken } = vi.hoisted(() => ({
  mockGenerateAuthUrl: vi.fn(),
  mockGetToken: vi.fn(),
  mockVerifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// ---------------------------------------------------------------------------
// Email mock — prevents real Resend calls during tests
// ---------------------------------------------------------------------------

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendUpgradeEmail: vi.fn().mockResolvedValue(undefined),
  sendDowngradeScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendCancellationScheduledEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendRefundConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendPlanDowngradeAppliedEmail: vi.fn().mockResolvedValue(undefined),
}));

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
  // Delete in FK-safe order: payment → subscription → session → user
  await truncateAllUserData();
  await clearRedisAuthKeys();
  // retrofit-6: clearRedisAuthKeys doesn't cover the password-reset keys.
  const resetKeys = (
    await Promise.all([redis.keys('password_reset:*'), redis.keys('reset_request:*')])
  ).flat();
  if (resetKeys.length > 0) await redis.del(resetKeys);
  vi.clearAllMocks();
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
  expect(json.data.user).not.toHaveProperty('authProviderId');
  expect(json.data.user.newsletterSubscribed).toBe(false);

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

  // Lockout counter incremented (keyed per (email, IP); tests have no client IP → 'unknown')
  const count = await redis.get(`lockout:login:${emailIpSubject(TEST_EMAIL, null)}`);
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
  const before = await redis.get(`lockout:login:${emailIpSubject(TEST_EMAIL, null)}`);
  expect(parseInt(before ?? '0', 10)).toBe(2);

  // Successful login clears it
  const res = await loginTestUser();
  expect(res.status).toBe(200);

  const after = await redis.get(`lockout:login:${emailIpSubject(TEST_EMAIL, null)}`);
  expect(after).toBeNull();
});

// ---------------------------------------------------------------------------
// 7b. Lockout is per (email, IP) — an attacker on IP-A locking an account
//     must NOT lock the real owner out from IP-B (anti targeted-DoS). [audit SEC]
// ---------------------------------------------------------------------------

function postFromIp(path: string, body: Record<string, unknown>, ip: string): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

it('7b: per-IP lockout — failures from one IP do not lock the account from another IP', async () => {
  await registerTestUser();
  const attackerIp = '203.0.113.7';

  // 6 wrong attempts from the attacker IP → that (email, IP) pair locks out.
  for (let i = 0; i < 6; i++) {
    await postFromIp('/login', { email: TEST_EMAIL, password: 'WrongPass1' }, attackerIp);
  }
  const lockedRes = await postFromIp('/login', { email: TEST_EMAIL, password: TEST_PASSWORD }, attackerIp);
  expect(lockedRes.status).toBe(423);

  // The real owner on a different IP can still log in successfully.
  const ownerRes = await postFromIp('/login', { email: TEST_EMAIL, password: TEST_PASSWORD }, '198.51.100.20');
  expect(ownerRes.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 7c. Unknown email is enumeration-uniform: same 401 INVALID_CREDENTIALS and a
//     lockout counter is still recorded (dummy-hash compare keeps timing even).
// ---------------------------------------------------------------------------

it('7c: login with an unknown email returns 401 INVALID_CREDENTIALS and records a failure', async () => {
  const res = await post('/login', { email: 'nobody@neonfi.test', password: 'WrongPass1' });
  expect(res.status).toBe(401);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_CREDENTIALS');

  const count = await redis.get(`lockout:login:${emailIpSubject('nobody@neonfi.test', null)}`);
  expect(parseInt(count ?? '0', 10)).toBe(1);
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
// 11. Refresh — new session cookie AND a rotated refresh cookie issued
// ---------------------------------------------------------------------------

it('11: refresh with valid refresh cookie issues a new session cookie and rotates the refresh token', async () => {
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

  // Refresh token is ROTATED (audit SEC decision 7): a new refresh cookie is set and differs.
  const newRefresh = cookieValue(res, 'refresh');
  expect(newRefresh).toBeTruthy();
  expect(newRefresh).not.toBe(refreshCookie);
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

// ---------------------------------------------------------------------------
// 13. Refresh — rotation + reuse detection (audit SEC decision 7)
//     A rotated-out refresh token, replayed, is rejected AND revokes the session
//     family so the new (rotated) token can no longer refresh either.
// ---------------------------------------------------------------------------

it('13: replaying a rotated-out refresh token is rejected and revokes the session family', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const firstRefresh = cookieValue(loginRes, 'refresh')!;

  // First refresh rotates firstRefresh → secondRefresh.
  const r1 = await post('/refresh', {}, `refresh=${firstRefresh}`);
  expect(r1.status).toBe(200);
  const secondRefresh = cookieValue(r1, 'refresh')!;
  expect(secondRefresh).not.toBe(firstRefresh);

  // Replaying the now-consumed firstRefresh → 401 (reuse), and it revokes the session.
  const reuse = await post('/refresh', {}, `refresh=${firstRefresh}`);
  expect(reuse.status).toBe(401);
  expect(((await reuse.json()) as { error: { code: string } }).error.code).toBe('INVALID_REFRESH_TOKEN');

  // The session is revoked, so even the legitimate rotated token can no longer refresh.
  const afterRevoke = await post('/refresh', {}, `refresh=${secondRefresh}`);
  expect(afterRevoke.status).toBe(401);
  expect(((await afterRevoke.json()) as { error: { code: string } }).error.code).toBe('SESSION_EXPIRED');

  // DB confirms the session row is revoked.
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const sessions = await prisma.session.findMany({ where: { userId: dbUser.id } });
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.revokedAt).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Stage 1B helpers
// ---------------------------------------------------------------------------

// Fixed state value used in all callback tests (valid base64url-safe string)
const TEST_OAUTH_STATE = 'dGVzdC1zdGF0ZS10b2tlbi1mb3ItdGVzdHMxMjM0NTY';

const GOOGLE_EMAIL = 'google.user@neonfi.test';
const TEST_EMAIL_2 = 'second.user@neonfi.test';

async function get(path: string, cookies?: string): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function del(path: string, cookies?: string): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function seedOAuthState(returnTo = '/dashboard'): Promise<void> {
  await redis.set(
    `oauth_state:${TEST_OAUTH_STATE}`,
    JSON.stringify({ returnTo, createdAt: new Date().toISOString() }),
    'EX',
    600,
  );
}

function setupGoogleMock(opts?: {
  email?: string;
  emailVerified?: boolean;
  getTokenThrows?: boolean;
  noIdToken?: boolean;
}): void {
  mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1');
  if (opts?.getTokenThrows) {
    mockGetToken.mockRejectedValue(new Error('invalid_grant'));
  } else if (opts?.noIdToken) {
    mockGetToken.mockResolvedValue({ tokens: {} });
  } else {
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'fake-id-token' } });
  }
  mockVerifyIdToken.mockResolvedValue({
    getPayload: () => ({
      email: opts?.email ?? GOOGLE_EMAIL,
      email_verified: opts?.emailVerified ?? true,
      name: 'Google User',
      picture: null,
      sub: 'google-sub-123',
    }),
  });
}

// ---------------------------------------------------------------------------
// 13. GET /auth/google — happy path: 302, sets oauth_state cookie, Redis key
// ---------------------------------------------------------------------------

it('13: GET /auth/google redirects to Google and sets oauth_state cookie', async () => {
  mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1');

  const res = await get('/google');
  expect(res.status).toBe(302);

  const location = res.headers.get('location') ?? '';
  expect(location).toContain('accounts.google.com');

  // oauth_state cookie set with correct attributes
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const oauthHeader = setCookies.find((c) => c.startsWith('oauth_state=')) ?? '';
  expect(oauthHeader).toBeTruthy();
  expect(oauthHeader.toLowerCase()).toContain('httponly');
  expect(oauthHeader.toLowerCase()).toContain('samesite=lax');
  expect(oauthHeader).toContain('Path=/api/v1/auth/google');

  // Redis key created for the generated state
  const state = cookieValue(res, 'oauth_state');
  expect(state).toBeTruthy();
  const redisVal = await redis.get(`oauth_state:${state}`);
  expect(redisVal).toBeTruthy();
  const parsed = JSON.parse(redisVal!) as { returnTo: string };
  expect(parsed.returnTo).toBe('/dashboard');
});

// ---------------------------------------------------------------------------
// 14. GET /auth/google?return_to=/wallet — returnTo stored in Redis
// ---------------------------------------------------------------------------

it('14: GET /auth/google stores return_to=/wallet in Redis', async () => {
  mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1');

  const res = await get('/google?return_to=/wallet');
  const state = cookieValue(res, 'oauth_state');
  const redisVal = await redis.get(`oauth_state:${state}`);
  const parsed = JSON.parse(redisVal!) as { returnTo: string };
  expect(parsed.returnTo).toBe('/wallet');
});

// ---------------------------------------------------------------------------
// 15. GET /auth/google?return_to=https://evil.com — open-redirect blocked
// ---------------------------------------------------------------------------

it('15: GET /auth/google blocks open-redirect, defaults returnTo to /dashboard', async () => {
  mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1');

  const res = await get('/google?return_to=https://evil.com');
  const state = cookieValue(res, 'oauth_state');
  const redisVal = await redis.get(`oauth_state:${state}`);
  const parsed = JSON.parse(redisVal!) as { returnTo: string };
  expect(parsed.returnTo).toBe('/dashboard');
});

// ---------------------------------------------------------------------------
// 16. GET /auth/google/callback — new Google user created, session issued
// ---------------------------------------------------------------------------
