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

it('16: callback creates new Google user, session, sets cookies, redirects', async () => {
  await seedOAuthState();
  setupGoogleMock();

  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  const location = res.headers.get('location') ?? '';
  expect(location).toContain('/dashboard');

  // User created with google provider
  const user = await prisma.user.findUnique({
    where: { email: GOOGLE_EMAIL },
    include: { authProvider: true, onboardingStatus: true },
  });
  expect(user).toBeTruthy();
  expect(user!.authProvider.name).toBe('google');
  expect(user!.onboardingStatus.name).toBe('verified');
  expect(user!.passwordHash).toBeNull();

  // Session created
  const sessions = await prisma.session.findMany({ where: { userId: user!.id } });
  expect(sessions).toHaveLength(1);

  // Auth cookies set
  const setCookies = res.headers.getSetCookie?.() ?? [];
  expect(setCookies.some((c) => c.startsWith('session='))).toBe(true);
  expect(setCookies.some((c) => c.startsWith('refresh='))).toBe(true);

  // oauth_state cookie cleared
  expect(cookieValue(res, 'oauth_state')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 17. GET /auth/google/callback — returning Google user logs in (no new User row)
// ---------------------------------------------------------------------------

it('17: callback logs in existing Google user without creating a duplicate', async () => {
  await seedOAuthState();
  setupGoogleMock();

  // First login — creates the user
  await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  await seedOAuthState(); // re-seed state for second login
  vi.clearAllMocks();
  setupGoogleMock();

  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);

  // Still only one user row
  const users = await prisma.user.findMany({ where: { email: GOOGLE_EMAIL } });
  expect(users).toHaveLength(1);

  // Two sessions (one per login)
  const sessions = await prisma.session.findMany({ where: { userId: users[0]!.id } });
  expect(sessions).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// 18. GET /auth/google/callback — email collision with email-auth account → 302 error
// ---------------------------------------------------------------------------

it('18: callback redirects with email_in_use_with_password when email has password account', async () => {
  // Register an email-auth user with the same email as the Google mock
  await post('/register', {
    email: GOOGLE_EMAIL,
    password: 'Test1234',
    fullName: 'Existing User',
  });

  await seedOAuthState();
  setupGoogleMock({ email: GOOGLE_EMAIL });

  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=email_in_use_with_password');
});

// ---------------------------------------------------------------------------
// 19. GET /auth/google/callback — missing oauth_state cookie → redirect invalid_state
// ---------------------------------------------------------------------------

it('19: callback without oauth_state cookie redirects with invalid_state', async () => {
  await seedOAuthState();

  // No cookie header
  const res = await get(`/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`);

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_state');
});

// ---------------------------------------------------------------------------
// 20. GET /auth/google/callback — cookie/query state mismatch → redirect invalid_state
// ---------------------------------------------------------------------------

it('20: callback with mismatched state cookie redirects with invalid_state', async () => {
  await seedOAuthState();

  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    'oauth_state=wrong-state-value',
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_state');
});

// ---------------------------------------------------------------------------
// 21. GET /auth/google/callback — Redis key missing (expired/replayed) → redirect invalid_state
// ---------------------------------------------------------------------------

it('21: callback with expired/missing Redis state redirects with invalid_state', async () => {
  // Do NOT seed Redis — key is absent
  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_state');
});

// ---------------------------------------------------------------------------
// 22. GET /auth/google/callback — error query param → redirect access_denied
// ---------------------------------------------------------------------------

it('22: callback with ?error=access_denied redirects with oauth_error=access_denied', async () => {
  const res = await get(
    `/google/callback?error=access_denied&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=access_denied');
});

// ---------------------------------------------------------------------------
// 23. GET /auth/google/callback — getToken throws → redirect invalid_token
// ---------------------------------------------------------------------------

it('23: callback when getToken throws redirects with oauth_error=invalid_token', async () => {
  await seedOAuthState();
  setupGoogleMock({ getTokenThrows: true });

  const res = await get(
    `/google/callback?code=bad-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_token');
});

// ---------------------------------------------------------------------------
// 24. GET /auth/google/callback — unverified email in payload → redirect invalid_token
// ---------------------------------------------------------------------------

it('24: callback with email_verified=false redirects with oauth_error=invalid_token', async () => {
  await seedOAuthState();
  setupGoogleMock({ emailVerified: false });

  const res = await get(
    `/google/callback?code=fake-code&state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_token');
});

// ---------------------------------------------------------------------------
// 25. GET /auth/google/callback — missing code param → redirect invalid_token
// ---------------------------------------------------------------------------

it('25: callback without code param redirects with oauth_error=invalid_token', async () => {
  await seedOAuthState();
  // No code — state validates, but code exchange fails
  const res = await get(
    `/google/callback?state=${TEST_OAUTH_STATE}`,
    `oauth_state=${TEST_OAUTH_STATE}`,
  );

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('oauth_error=invalid_token');
});

// ---------------------------------------------------------------------------
// 26. GET /auth/sessions — authenticated user gets list with 1 current session
// ---------------------------------------------------------------------------

it('26: GET /auth/sessions returns 1 session with current=true', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;

  const res = await get('/sessions', `session=${sessionCookie}`);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { sessions: Array<{ id: number; current: boolean }> };
    meta: { total: number };
  };
  expect(json.meta.total).toBe(1);
  expect(json.data.sessions).toHaveLength(1);
  expect(json.data.sessions[0]!.current).toBe(true);
  expect(json.data.sessions[0]).not.toHaveProperty('userId');
});

// ---------------------------------------------------------------------------
// 27. GET /auth/sessions — unauthenticated returns 401
// ---------------------------------------------------------------------------

it('27: GET /auth/sessions without auth returns 401', async () => {
  const res = await get('/sessions');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 28. GET /auth/sessions — two active sessions, correct current flag per caller
// ---------------------------------------------------------------------------

it('28: GET /auth/sessions shows 2 sessions with correct current flag', async () => {
  await registerTestUser();
  const loginRes1 = await loginTestUser(); // session 1
  const loginRes2 = await loginTestUser(); // session 2
  const cookie2 = cookieValue(loginRes2, 'session')!;

  const res = await get('/sessions', `session=${cookie2}`);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { sessions: Array<{ current: boolean }> };
    meta: { total: number };
  };
  expect(json.meta.total).toBe(2);
  expect(json.data.sessions.filter((s) => s.current)).toHaveLength(1);
  expect(json.data.sessions.filter((s) => !s.current)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// 29. DELETE /auth/sessions/:id — revoke non-current session, loggedOut=false
// ---------------------------------------------------------------------------

it('29: DELETE /auth/sessions/:id revokes a non-current session; loggedOut=false', async () => {
  await registerTestUser();
  await loginTestUser(); // session A (older)
  const loginResB = await loginTestUser(); // session B (current)
  const cookieB = cookieValue(loginResB, 'session')!;

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const sessions = await prisma.session.findMany({
    where: { userId: dbUser.id },
    orderBy: { createdAt: 'asc' },
  });
  const sessionAId = sessions[0]!.id;

  const res = await del(`/sessions/${sessionAId}`, `session=${cookieB}`);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { ok: boolean; loggedOut: boolean } };
  expect(json.data.ok).toBe(true);
  expect(json.data.loggedOut).toBe(false);

  // Session A revoked in DB
  const sessionA = await prisma.session.findUnique({ where: { id: sessionAId } });
  expect(sessionA!.revokedAt).not.toBeNull();

  // Auth cookies NOT cleared (Max-Age not 0)
  expect(cookieMaxAge(res, 'session')).not.toBe(0);
});

// ---------------------------------------------------------------------------
// 30. DELETE /auth/sessions/:id — revoke current session, loggedOut=true, cookies cleared
// ---------------------------------------------------------------------------

it('30: DELETE /auth/sessions/:id on current session returns loggedOut=true and clears cookies', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const session = await prisma.session.findFirst({ where: { userId: dbUser.id } });
  const sessionId = session!.id;

  const res = await del(`/sessions/${sessionId}`, `session=${sessionCookie}`);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { ok: boolean; loggedOut: boolean } };
  expect(json.data.ok).toBe(true);
  expect(json.data.loggedOut).toBe(true);

  // Auth cookies cleared
  expect(cookieMaxAge(res, 'session')).toBe(0);
  expect(cookieMaxAge(res, 'refresh')).toBe(0);
});

// ---------------------------------------------------------------------------
// 31. DELETE /auth/sessions/:id — wrong user's session returns 403
// ---------------------------------------------------------------------------

it('31: DELETE /auth/sessions/:id on another users session returns 403', async () => {
  // User A
  await registerTestUser();
  const loginResA = await loginTestUser();
  const cookieA = cookieValue(loginResA, 'session')!;

  // User B
  await post('/register', { email: TEST_EMAIL_2, password: 'Test1234', fullName: 'User B' });
  const loginResB = await post('/login', { email: TEST_EMAIL_2, password: 'Test1234' });
  const userB = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL_2 } });
  const sessionB = await prisma.session.findFirst({ where: { userId: userB.id } });

  // User A tries to delete User B's session
  const res = await del(`/sessions/${sessionB!.id}`, `session=${cookieA}`);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 32. DELETE /auth/sessions/:id — non-existent session ID returns 403
// ---------------------------------------------------------------------------

it('32: DELETE /auth/sessions/:id with non-existent ID returns 403', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;

  const res = await del('/sessions/99999999', `session=${sessionCookie}`);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 33. GET /auth/ws-token — returns token + expiresIn=60, Redis key exists
// ---------------------------------------------------------------------------

it('33: GET /auth/ws-token issues ticket stored in Redis as userId:sessionId', async () => {
  await registerTestUser();
  const loginRes = await loginTestUser();
  const sessionCookie = cookieValue(loginRes, 'session')!;

  const res = await get('/ws-token', `session=${sessionCookie}`);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { token: string; expiresIn: number } };
  expect(json.data.token).toBeTruthy();
  expect(json.data.expiresIn).toBe(60);

  // Redis key exists with userId:sessionId format
  const redisVal = await redis.get(`ws_ticket:${json.data.token}`);
  expect(redisVal).toBeTruthy();
  const [userId, sessionId] = redisVal!.split(':');
  expect(parseInt(userId!, 10)).toBeGreaterThan(0);
  expect(parseInt(sessionId!, 10)).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 34. GET /auth/ws-token — unauthenticated returns 401
// ---------------------------------------------------------------------------

it('34: GET /auth/ws-token without auth returns 401', async () => {
  const res = await get('/ws-token');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Password reset (retrofit-6)
// ---------------------------------------------------------------------------

const NEW_PASSWORD = 'NewPass5678';

async function readResetToken(): Promise<string> {
  const keys = await redis.keys('password_reset:*');
  expect(keys).toHaveLength(1);
  return keys[0]!.replace('password_reset:', '');
}

// ---------------------------------------------------------------------------
// 35. Request — email user → 200, token stored in Redis, email sent
// ---------------------------------------------------------------------------

it('35: password-reset request for an email user returns 200, stores token, sends email', async () => {
  await registerTestUser();
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });

  const res = await post('/password-reset', { email: TEST_EMAIL });
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { ok: boolean } };
  expect(json.data.ok).toBe(true);

  // No token/cookie leaked in the response
  expect(cookieValue(res, 'session')).toBeUndefined();

  // Token stored in Redis, mapped to the user id (FIFO: SET is enqueued before our KEYS)
  const token = await readResetToken();
  const stored = await redis.get(`password_reset:${token}`);
  expect(stored).toBe(String(dbUser.id));

  // Email dispatched (fire-and-forget runs after the SET resolves)
  await vi.waitFor(() => {
    expect(vi.mocked(sendPasswordResetEmail)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 36. Request — nonexistent email → 200, no token, no email (uniform)
// ---------------------------------------------------------------------------

it('36: password-reset request for a nonexistent email returns 200 with no token or email', async () => {
  const res = await post('/password-reset', { email: 'nobody@neonfi.test' });
  expect(res.status).toBe(200);

  const keys = await redis.keys('password_reset:*');
  expect(keys).toHaveLength(0);
  expect(vi.mocked(sendPasswordResetEmail)).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 37. Request — Google-only user → 200, no token (can't reset a password)
// ---------------------------------------------------------------------------

it('37: password-reset request for a Google-only account returns 200 with no token', async () => {
  const [googleProvider, verifiedStatus] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'google' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'verified' } }),
  ]);
  await prisma.user.create({
    data: {
      email: GOOGLE_EMAIL,
      passwordHash: null,
      fullName: 'Google User',
      authProviderId: googleProvider.id,
      onboardingStatusId: verifiedStatus.id,
    },
  });

  const res = await post('/password-reset', { email: GOOGLE_EMAIL });
  expect(res.status).toBe(200);

  const keys = await redis.keys('password_reset:*');
  expect(keys).toHaveLength(0);
  expect(vi.mocked(sendPasswordResetEmail)).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 38. Request — twice within 60s → 2nd returns 429 (rate-limit first)
// ---------------------------------------------------------------------------

it('38: a second password-reset request within 60s returns 429 TOO_MANY_REQUESTS', async () => {
  await registerTestUser();

  const first = await post('/password-reset', { email: TEST_EMAIL });
  expect(first.status).toBe(200);

  const second = await post('/password-reset', { email: TEST_EMAIL });
  expect(second.status).toBe(429);
  const json = await second.json() as { error: { code: string } };
  expect(json.error.code).toBe('TOO_MANY_REQUESTS');
});

// ---------------------------------------------------------------------------
// 39. Confirm — full cycle: new password works, old fails, single-use, sessions revoked
// ---------------------------------------------------------------------------

it('39: password-reset confirm sets the new password, revokes sessions, is single-use', async () => {
  await registerTestUser();
  // An active session that the reset must lock out
  const loginRes = await loginTestUser();
  expect(loginRes.status).toBe(200);
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  const priorSession = await prisma.session.findFirstOrThrow({ where: { userId: dbUser.id } });

  // Request + grab the token
  await post('/password-reset', { email: TEST_EMAIL });
  const token = await readResetToken();

  // Confirm with a strong new password
  const confirmRes = await post('/password-reset/confirm', { token, password: NEW_PASSWORD });
  expect(confirmRes.status).toBe(200);
  const confirmJson = await confirmRes.json() as { data: { ok: boolean } };
  expect(confirmJson.data.ok).toBe(true);

  // No auto-login — no cookies returned
  expect(cookieValue(confirmRes, 'session')).toBeUndefined();
  expect(cookieValue(confirmRes, 'refresh')).toBeUndefined();

  // Prior session revoked
  const revoked = await prisma.session.findUniqueOrThrow({ where: { id: priorSession.id } });
  expect(revoked.revokedAt).not.toBeNull();

  // Token is single-use — replay is rejected
  const replay = await post('/password-reset/confirm', { token, password: NEW_PASSWORD });
  expect(replay.status).toBe(400);
  const replayJson = await replay.json() as { error: { code: string } };
  expect(replayJson.error.code).toBe('INVALID_RESET_TOKEN');

  // Old password no longer works
  const oldLogin = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  expect(oldLogin.status).toBe(401);

  // New password works
  const newLogin = await post('/login', { email: TEST_EMAIL, password: NEW_PASSWORD });
  expect(newLogin.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 40. Confirm — invalid/expired token → 400 INVALID_RESET_TOKEN
// ---------------------------------------------------------------------------

it('40: password-reset confirm with an invalid token returns 400 INVALID_RESET_TOKEN', async () => {
  const res = await post('/password-reset/confirm', { token: 'notarealtoken', password: NEW_PASSWORD });
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_RESET_TOKEN');
});

// ---------------------------------------------------------------------------
// 41. Confirm — weak password → 400 WEAK_PASSWORD (validation before token check)
// ---------------------------------------------------------------------------

it('41: password-reset confirm with a weak password returns 400 WEAK_PASSWORD', async () => {
  const res = await post('/password-reset/confirm', { token: 'anytoken', password: 'short1' });
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('WEAK_PASSWORD');
});
