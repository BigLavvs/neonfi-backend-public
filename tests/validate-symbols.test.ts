// Neonfi backend — POST /tokens/validate-symbols tests (retrofit-87).
//
// Read-only pre-import check for the CSV-import preview. Real DB + Redis; the token catalog
// is a seeded lookup table (never truncated), so the known symbols below always resolve.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

const AUTH_BASE = '/api/v1/auth';
const VALIDATE_URL = '/api/v1/tokens/validate-symbols';
const TEST_EMAIL = 'validate.symbols@neonfi.test';
const TEST_PASSWORD = 'Test1234';

async function registerAndLogin(): Promise<string> {
  await app.request(`${AUTH_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, fullName: 'Validate Symbols' }),
  });
  const res = await app.request(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  return `session=${cookieValue(res, 'session')!}`;
}

function post(body: unknown, cookies?: string): Promise<Response> {
  return app.request(VALIDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

it('returns only the unrecognized symbols, upper-cased', async () => {
  const cookies = await registerAndLogin();
  const res = await post({ symbols: ['BTC', 'ETH', 'totallynotacoin'] }, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { unknown: string[] } };
  expect(json.data.unknown).toEqual(['TOTALLYNOTACOIN']);
});

it('normalizes case + dedups so a known symbol in any case resolves', async () => {
  const cookies = await registerAndLogin();
  const res = await post({ symbols: ['btc', 'BTC', '  eth  ', 'nope', 'NOPE'] }, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { unknown: string[] } };
  // btc/BTC/eth all resolve; 'nope'/'NOPE' collapse to one unknown.
  expect(json.data.unknown).toEqual(['NOPE']);
});

it('empty symbol list → empty unknown', async () => {
  const cookies = await registerAndLogin();
  const res = await post({ symbols: [] }, cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { unknown: string[] } };
  expect(json.data.unknown).toEqual([]);
});

it('over 1000 symbols → 400 VALIDATION_ERROR (cap)', async () => {
  const cookies = await registerAndLogin();
  const symbols = Array.from({ length: 1001 }, (_, i) => `SYM${i}`);
  const res = await post({ symbols }, cookies);
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

it('unauthenticated → 401', async () => {
  const res = await post({ symbols: ['BTC'] });
  expect(res.status).toBe(401);
});
