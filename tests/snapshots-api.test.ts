// Neonfi backend — Snapshots read endpoint integration tests (retrofit-3).
//
// GET /api/v1/portfolios/:portfolioId/snapshots — Pro-only, offset-paginated,
// snapshotDate DESC. Real DB + Redis; per-test cleanup. Users authenticate via
// register/login (cookie); subscriptions, portfolios, and snapshot rows are seeded
// directly via Prisma. Tests 313-320.

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock — register/login send mails we don't exercise here
// ---------------------------------------------------------------------------

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
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

const AUTH_BASE = '/api/v1/auth';
const snapBase = (portfolioId: number) => `/api/v1/portfolios/${portfolioId}/snapshots`;

const TEST_EMAIL = 'snap.api@neonfi.test';
const TEST_PASSWORD = 'Test1234';

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
  fullName = 'Snapshot Api',
): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function createProSub(userId: number): Promise<void> {
  const [plan, cycle, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } }),
    prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      billingCycleId: cycle.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    },
  });
}

async function createFreeSub(userId: number): Promise<void> {
  const [plan, status] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { name: 'free' } }),
    prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } }),
  ]);
  await prisma.subscription.create({
    data: { userId, planId: plan.id, statusId: status.id, currentPeriodStart: new Date('2026-06-01T00:00:00Z'), currentPeriodEnd: null },
  });
}

async function createManualPortfolio(userId: number, name = 'P'): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const p = await prisma.portfolio.create({ data: { userId, name, typeId: type.id } });
  return p.id;
}

async function seedSnapshot(
  portfolioId: number,
  userId: number,
  ymd: string,
  value: number,
): Promise<void> {
  await prisma.balanceSnapshot.create({
    data: {
      portfolioId,
      userId,
      snapshotDate: new Date(`${ymd}T00:00:00.000Z`),
      value: value.toString(),
    },
  });
}

function snapGet(portfolioId: number, query = '', cookies?: string): Promise<Response> {
  return app.request(`${snapBase(portfolioId)}${query}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Setup — clear hypertable first (cascade-truncate then only hits empty table)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

// ---------------------------------------------------------------------------
// 313-320
// ---------------------------------------------------------------------------

it('313: GET /snapshots — Pro user, 5 rows → 200, length 5, ordered snapshotDate DESC', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  for (const [ymd, v] of [['2026-06-09', 9], ['2026-06-13', 13], ['2026-06-11', 11], ['2026-06-10', 10], ['2026-06-12', 12]] as const) {
    await seedSnapshot(portfolioId, userId, ymd, v);
  }

  const res = await snapGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { snapshots: Array<{ snapshotDate: string }> }; meta: { total: number } };
  expect(json.data.snapshots).toHaveLength(5);
  expect(json.meta.total).toBe(5);
  // Strictly descending by snapshotDate
  const dates = json.data.snapshots.map((s) => s.snapshotDate);
  expect(dates).toEqual(['2026-06-13', '2026-06-12', '2026-06-11', '2026-06-10', '2026-06-09']);
});

it('314: GET /snapshots paginated — 10 rows, ?limit=3&offset=2 → length 3, meta + correct slice', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  // dates 2026-06-01..2026-06-10, value encodes the day
  for (let day = 1; day <= 10; day++) {
    const ymd = `2026-06-${String(day).padStart(2, '0')}`;
    await seedSnapshot(portfolioId, userId, ymd, day);
  }

  const res = await snapGet(portfolioId, '?limit=3&offset=2', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { snapshots: Array<{ value: number; snapshotDate: string }> };
    meta: { limit: number; offset: number; total: number };
  };
  expect(json.data.snapshots).toHaveLength(3);
  expect(json.meta).toMatchObject({ limit: 3, offset: 2, total: 10 });
  // DESC: day 10,9,8,7,6,... offset 2 skips 10,9 → 8,7,6
  expect(json.data.snapshots.map((s) => s.value)).toEqual([8, 7, 6]);
});

it('315: GET /snapshots ?limit=800 → 400 VALIDATION_ERROR (max 730)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await snapGet(portfolioId, '?limit=800', cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

it('316: GET /snapshots as Free user → 403 PLAN_LIMIT_REACHED', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createFreeSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await snapGet(portfolioId, '', cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
});

it('317: GET /snapshots on another user\'s portfolio → 403 FORBIDDEN', async () => {
  // Requesting user (Pro)
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);

  // Other user (Pro) owns the portfolio
  await registerAndLogin('snap.api.other@neonfi.test', TEST_PASSWORD, 'Other');
  const otherId = await getUserId('snap.api.other@neonfi.test');
  await createProSub(otherId);
  const othersPortfolio = await createManualPortfolio(otherId);

  const res = await snapGet(othersPortfolio, '', cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

it('318: GET /snapshots on portfolio with no rows → 200, empty list, total 0', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await snapGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { snapshots: unknown[] }; meta: { total: number } };
  expect(json.data.snapshots).toEqual([]);
  expect(json.meta.total).toBe(0);
});

it('319: GET /snapshots with no auth → 401', async () => {
  const userId = (async () => {
    await registerAndLogin();
    return getUserId();
  });
  const id = await userId();
  await createProSub(id);
  const portfolioId = await createManualPortfolio(id);

  const res = await snapGet(portfolioId, '' /* no cookie */);
  expect(res.status).toBe(401);
});

it('320: GET /snapshots response shape — id, portfolioId, userId, value(number), snapshotDate(YYYY-MM-DD), createdAt(ISO)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSub(userId);
  const portfolioId = await createManualPortfolio(userId);
  await seedSnapshot(portfolioId, userId, '2026-04-09', 10133.37);

  const res = await snapGet(portfolioId, '', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { snapshots: Array<Record<string, unknown>> } };
  const row = json.data.snapshots[0]!;
  expect(Object.keys(row).sort()).toEqual(
    ['createdAt', 'id', 'portfolioId', 'snapshotDate', 'userId', 'value'].sort(),
  );
  expect(typeof row.id).toBe('number');
  expect(row.portfolioId).toBe(portfolioId);
  expect(row.userId).toBe(userId);
  expect(typeof row.value).toBe('number');
  expect(row.value).toBeCloseTo(10133.37);
  expect(row.snapshotDate).toBe('2026-04-09'); // bare calendar day
  // createdAt serialized as ISO timestamp string
  expect(typeof row.createdAt).toBe('string');
  expect(() => new Date(row.createdAt as string).toISOString()).not.toThrow();
});
