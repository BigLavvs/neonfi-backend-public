// Neonfi backend — Users module integration tests (Stage 2).
//
// Strategy: same as auth.test.ts — dev DB + Redis, per-test truncation.
// beforeEach truncates session and user tables, clears auth Redis keys.
// Uses Hono's app.request() for in-process HTTP.

import { it, beforeEach, expect } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_BASE = '/api/v1/auth';
const USERS_BASE = '/api/v1/users';

const TEST_EMAIL = 'users.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Users Integration';

async function authPost(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookies?: string): Promise<Response> {
  return app.request(`${USERS_BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function patch(
  path: string,
  body: Record<string, unknown>,
  cookies?: string,
): Promise<Response> {
  return app.request(`${USERS_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(): Promise<string> {
  await authPost('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });
  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  return `session=${cookieValue(loginRes, 'session')!}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 35. GET /users/me — full DTO with all fields, no sensitive data
// ---------------------------------------------------------------------------

it('35: GET /users/me returns full DTO with correct fields', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await get('/me', sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  const user = json.data.user;

  // Identity fields
  expect(typeof user.id).toBe('number');
  expect(user.email).toBe(TEST_EMAIL);
  expect(user.fullName).toBe(TEST_FULL_NAME);
  expect(user.displayName).toBeNull();
  expect(user.avatarUrl).toBeNull();
  expect(user.authProvider).toBe('email');

  // Gate D: pending_verification user has emailVerified=false
  expect(user.emailVerified).toBe(false);
  expect(user.onboardingStatus).toBe('pending_verification');

  // Stage 2 fields
  expect(user.plan).toBeNull();
  expect(user.billingCycle).toBeNull();
  expect(user.newsletterSubscribed).toBe(false);
  expect(user.createdAt).toBeTruthy();
  expect(user.updatedAt).toBeTruthy();

  // Sensitive fields MUST NOT be exposed
  expect(user).not.toHaveProperty('passwordHash');
  expect(user).not.toHaveProperty('authProviderId');
  expect(user).not.toHaveProperty('onboardingStatusId');
});

// ---------------------------------------------------------------------------
// 36. GET /users/me — verified user shows emailVerified=true
// ---------------------------------------------------------------------------

it('36: GET /users/me — emailVerified is true after email verification', async () => {
  await authPost('/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    fullName: TEST_FULL_NAME,
  });

  // Grab the verification token from Redis and verify
  const keys = await redis.keys('email_verify:*');
  const token = keys[0]!.replace('email_verify:', '');
  await authPost('/verify-email', { token });

  const loginRes = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const sessionCookie = `session=${cookieValue(loginRes, 'session')!}`;

  const res = await get('/me', sessionCookie);
  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.emailVerified).toBe(true);
  expect(json.data.user.onboardingStatus).toBe('verified');
});

// ---------------------------------------------------------------------------
// 37. GET /users/me — unauthenticated → 401
// ---------------------------------------------------------------------------

it('37: GET /users/me without auth returns 401', async () => {
  const res = await get('/me');
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 38. PATCH /users/me — update displayName
// ---------------------------------------------------------------------------

it('38: PATCH /users/me updates displayName in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { displayName: 'Neo' }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.displayName).toBe('Neo');

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.displayName).toBe('Neo');
});

// ---------------------------------------------------------------------------
// 39. PATCH /users/me — update fullName
// ---------------------------------------------------------------------------

it('39: PATCH /users/me updates fullName in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { fullName: 'Updated Name' }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.fullName).toBe('Updated Name');

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.fullName).toBe('Updated Name');
});

// ---------------------------------------------------------------------------
// 40. PATCH /users/me — update avatarUrl
// ---------------------------------------------------------------------------

it('40: PATCH /users/me updates avatarUrl in response and DB', async () => {
  const sessionCookie = await registerAndLogin();
  const url = 'https://example.com/avatar.png';

  const res = await patch('/me', { avatarUrl: url }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.avatarUrl).toBe(url);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBe(url);
});

// ---------------------------------------------------------------------------
// 41. PATCH /users/me — avatarUrl: null clears the field
// ---------------------------------------------------------------------------

it('41: PATCH /users/me with avatarUrl:null clears the field', async () => {
  const sessionCookie = await registerAndLogin();

  // Set it first
  await patch('/me', { avatarUrl: 'https://example.com/avatar.png' }, sessionCookie);

  // Now clear it
  const res = await patch('/me', { avatarUrl: null }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.avatarUrl).toBeNull();

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.avatarUrl).toBeNull();
});

// ---------------------------------------------------------------------------
// 42. PATCH /users/me — toggle newsletterSubscribed
// ---------------------------------------------------------------------------

it('42: PATCH /users/me toggles newsletterSubscribed in response and DB', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { newsletterSubscribed: true }, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.newsletterSubscribed).toBe(true);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.newsletterSubscribed).toBe(true);
});

// ---------------------------------------------------------------------------
// 43. PATCH /users/me — multiple fields updated atomically
// ---------------------------------------------------------------------------

it('43: PATCH /users/me updates multiple fields atomically', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch(
    '/me',
    {
      fullName: 'Atomic User',
      displayName: 'Atomic',
      newsletterSubscribed: true,
    },
    sessionCookie,
  );
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.fullName).toBe('Atomic User');
  expect(json.data.user.displayName).toBe('Atomic');
  expect(json.data.user.newsletterSubscribed).toBe(true);

  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  expect(dbUser.fullName).toBe('Atomic User');
  expect(dbUser.displayName).toBe('Atomic');
  expect(dbUser.newsletterSubscribed).toBe(true);
});

// ---------------------------------------------------------------------------
// 44. PATCH /users/me — empty body → 200 no-op
// ---------------------------------------------------------------------------

it('44: PATCH /users/me with empty body returns 200 with current user', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', {}, sessionCookie);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { user: Record<string, unknown> } };
  expect(json.data.user.email).toBe(TEST_EMAIL);
  expect(json.data.user.fullName).toBe(TEST_FULL_NAME);
});

// ---------------------------------------------------------------------------
// 45. PATCH /users/me — unknown field → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

it('45: PATCH /users/me with unknown field returns 400 VALIDATION_ERROR', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { email: 'new@example.com' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 46. PATCH /users/me — fullName too long → 400
// ---------------------------------------------------------------------------

it('46: PATCH /users/me rejects fullName longer than 255 chars', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { fullName: 'A'.repeat(256) }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 47. PATCH /users/me — displayName empty string → 400 (use null to clear)
// ---------------------------------------------------------------------------

it('47: PATCH /users/me rejects displayName empty string', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { displayName: '' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 48. PATCH /users/me — avatarUrl not a URL → 400
// ---------------------------------------------------------------------------

it('48: PATCH /users/me rejects avatarUrl that is not a valid URL', async () => {
  const sessionCookie = await registerAndLogin();

  const res = await patch('/me', { avatarUrl: 'not-a-url' }, sessionCookie);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 49. PATCH /users/me — no auth → 401
// ---------------------------------------------------------------------------

it('49: PATCH /users/me without auth returns 401', async () => {
  const res = await patch('/me', { displayName: 'Ghost' });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 50. PATCH /users/me — readback: GET confirms persisted changes
// ---------------------------------------------------------------------------

it('50: readback — GET /users/me returns values matching the PATCH response', async () => {
  const sessionCookie = await registerAndLogin();

  const patchRes = await patch(
    '/me',
    { displayName: 'Persist Check', newsletterSubscribed: true },
    sessionCookie,
  );
  const patchJson = await patchRes.json() as { data: { user: Record<string, unknown> } };

  const getRes = await get('/me', sessionCookie);
  const getJson = await getRes.json() as { data: { user: Record<string, unknown> } };

  expect(getJson.data.user.displayName).toBe('Persist Check');
  expect(getJson.data.user.newsletterSubscribed).toBe(true);
  expect(getJson.data.user.displayName).toBe(patchJson.data.user.displayName);
  expect(getJson.data.user.newsletterSubscribed).toBe(patchJson.data.user.newsletterSubscribed);
});
