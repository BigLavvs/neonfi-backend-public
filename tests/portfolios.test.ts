// Neonfi backend — Portfolios module integration tests (Stage 7).
//
// Strategy: real DB + Redis, per-test truncation of payment → subscription →
// portfolio → session → user. Token and chain tables are NOT touched.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';
import * as moralisStreams from '../src/lib/moralis-streams-client.js';

// ---------------------------------------------------------------------------
// Email mock
// ---------------------------------------------------------------------------

vi.mock('../src/lib/moralis-streams-client.js', () => ({
  createStream: vi.fn().mockResolvedValue({ id: 'mock-stream-123' }),
  deleteStream: vi.fn().mockResolvedValue(undefined),
}));

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
const PORT_BASE = '/api/v1/portfolios';
const TEST_EMAIL = 'portfolios.integration@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const TEST_FULL_NAME = 'Portfolios Integration';

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
  fullName = TEST_FULL_NAME,
): Promise<string> {
  await authPost('/register', { email, password, fullName });
  const res = await authPost('/login', { email, password });
  return `session=${cookieValue(res, 'session')!}`;
}

async function getUserId(email = TEST_EMAIL): Promise<number> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  return u.id;
}

async function createFreeSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      statusId: status.id,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: null,
    },
  });
}

async function createProSubForUser(userId: number): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  const cycle = await prisma.billingCycle.findUniqueOrThrow({ where: { name: 'monthly' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
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

async function createPortfolioInDb(userId: number, name: string, type: 'connected' | 'manual' = 'manual'): Promise<void> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: type } });
  await prisma.portfolio.create({ data: { userId, name, typeId: portfolioType.id } });
}

async function portPost(body: Record<string, unknown>, cookies?: string): Promise<Response> {
  return app.request(PORT_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function portGet(path: string, cookies?: string): Promise<Response> {
  return app.request(`${PORT_BASE}${path}`, {
    method: 'GET',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

async function portPatch(path: string, body: Record<string, unknown>, cookies?: string): Promise<Response> {
  return app.request(`${PORT_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function portDelete(path: string, cookies?: string): Promise<Response> {
  return app.request(`${PORT_BASE}${path}`, {
    method: 'DELETE',
    headers: { ...(cookies ? { Cookie: cookies } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Setup — payment → subscription → portfolio → session → user
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 138. POST /portfolios manual — happy path
// ---------------------------------------------------------------------------

it('138: POST /portfolios manual — 201, row in DB, type=manual, walletAddress=null, slug computed', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({ type: 'manual', name: 'My main' }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  const p = json.data.portfolio;
  expect(p.name).toBe('My main');
  expect(p.slug).toBe('my-main');
  expect(p.type).toBe('manual');
  expect(p.walletAddress).toBeNull();
  expect(p.chainId).toBeNull();
  expect(p.startingBalance).toBeNull();

  const count = await prisma.portfolio.count();
  expect(count).toBe(1);
});

// ---------------------------------------------------------------------------
// 139. POST /portfolios manual with startingBalance
// ---------------------------------------------------------------------------

it('139: POST /portfolios manual with startingBalance → 201, serialized as number', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({ type: 'manual', name: 'Savings', startingBalance: '1000.50' }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(typeof json.data.portfolio.startingBalance).toBe('number');
  expect(json.data.portfolio.startingBalance).toBe(1000.5);
});

// ---------------------------------------------------------------------------
// 140. POST /portfolios manual with extra `assets` field → 400 (strict)
// ---------------------------------------------------------------------------

it('140: POST /portfolios manual with extra `assets` field → 400 VALIDATION_ERROR (strict mode)', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({ type: 'manual', name: 'Test', assets: [] }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 141. POST /portfolios connected — happy path with Ethereum
// ---------------------------------------------------------------------------

it('141: POST /portfolios connected (Ethereum) → 201, walletAddress normalized to lowercase', async () => {
  const cookies = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const res = await portPost({
    type: 'connected',
    name: 'ETH Wallet',
    walletAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
    chainId: eth.id,
  }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  const p = json.data.portfolio;
  expect(p.type).toBe('connected');
  expect(p.walletAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  expect(p.chainId).toBe(eth.id);
  expect(p.startingBalance).toBeNull();
});

// ---------------------------------------------------------------------------
// 142. POST /portfolios connected with invalid wallet address → 400
// ---------------------------------------------------------------------------

it('142: POST /portfolios connected with invalid EVM address → 400 INVALID_WALLET_ADDRESS, meta.chainSlug=eth', async () => {
  const cookies = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const res = await portPost({
    type: 'connected',
    name: 'Bad Wallet',
    walletAddress: 'not-a-wallet',
    chainId: eth.id,
  }, cookies);
  expect(res.status).toBe(400);

  const json = await res.json() as { error: { code: string }; meta: { chainSlug: string } };
  expect(json.error.code).toBe('INVALID_WALLET_ADDRESS');
  expect(json.meta.chainSlug).toBe('eth');
});

// ---------------------------------------------------------------------------
// 143. POST /portfolios connected with Solana wallet (base58) — pro user
// ---------------------------------------------------------------------------

it('143: POST /portfolios connected (Solana) — pro user → 201, case preserved', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const solana = await prisma.chain.findUniqueOrThrow({ where: { slug: 'solana' } });

  const solanaAddress = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const res = await portPost({
    type: 'connected',
    name: 'Solana Wallet',
    walletAddress: solanaAddress,
    chainId: solana.id,
  }, cookies);
  expect(res.status).toBe(201);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(json.data.portfolio.walletAddress).toBe(solanaAddress);
});

// ---------------------------------------------------------------------------
// 144. POST /portfolios connected with non-existent chainId → 400 INVALID_CHAIN
// ---------------------------------------------------------------------------

it('144: POST /portfolios connected with non-existent chainId → 400 INVALID_CHAIN', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({
    type: 'connected',
    name: 'Unknown Chain',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    chainId: 999999,
  }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_CHAIN');
});

// ---------------------------------------------------------------------------
// 145. POST /portfolios connected as free user with Pro-only chain (Arbitrum)
// ---------------------------------------------------------------------------

it('145: POST /portfolios connected as free user with Arbitrum (Pro-only) → 403 PLAN_LIMIT_REACHED', async () => {
  const cookies = await registerAndLogin();
  const arb = await prisma.chain.findUniqueOrThrow({ where: { slug: 'arbitrum' } });

  const res = await portPost({
    type: 'connected',
    name: 'Arb Wallet',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    chainId: arb.id,
  }, cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string }; meta: { chainSlug: string; plan: string } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
  expect(json.meta.chainSlug).toBe('arbitrum');
  expect(json.meta.plan).toBe('free');
});

// ---------------------------------------------------------------------------
// 146. POST /portfolios connected with `startingBalance` → 400 (cross-shape leak)
// ---------------------------------------------------------------------------

it('146: POST /portfolios connected with startingBalance field → 400 VALIDATION_ERROR (strict)', async () => {
  const cookies = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const res = await portPost({
    type: 'connected',
    name: 'Wallet',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    chainId: eth.id,
    startingBalance: '500',
  }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 147. POST /portfolios manual with `walletAddress` → 400 (cross-shape leak)
// ---------------------------------------------------------------------------

it('147: POST /portfolios manual with walletAddress field → 400 VALIDATION_ERROR (strict)', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({
    type: 'manual',
    name: 'Manual',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
  }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 148. POST /portfolios free user with 1 existing portfolio → 403
// ---------------------------------------------------------------------------

it('148: POST /portfolios free user with 1 existing portfolio → 403 PLAN_LIMIT_REACHED meta.current=1 limit=1', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createPortfolioInDb(userId, 'Existing');

  const res = await portPost({ type: 'manual', name: 'Second' }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string }; meta: { current: number; limit: number } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
  expect(json.meta.current).toBe(1);
  expect(json.meta.limit).toBe(1);
});

// ---------------------------------------------------------------------------
// 149. POST /portfolios pro user with 10 existing portfolios → 403
// ---------------------------------------------------------------------------

it('149: POST /portfolios pro user with 10 existing portfolios → 403 PLAN_LIMIT_REACHED meta.current=10 limit=10', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  for (let i = 1; i <= 10; i++) {
    await createPortfolioInDb(userId, `Portfolio ${i}`);
  }

  const res = await portPost({ type: 'manual', name: 'Eleventh' }, cookies);
  expect(res.status).toBe(403);

  const json = await res.json() as { error: { code: string }; meta: { current: number; limit: number } };
  expect(json.error.code).toBe('PLAN_LIMIT_REACHED');
  expect(json.meta.current).toBe(10);
  expect(json.meta.limit).toBe(10);
});

// ---------------------------------------------------------------------------
// 150. POST /portfolios with duplicate name (case-insensitive) → 409
// ---------------------------------------------------------------------------

it('150: POST /portfolios with duplicate name (case-insensitive) → 409 NAME_TAKEN', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  await portPost({ type: 'manual', name: 'My Portfolio' }, cookies);
  const res = await portPost({ type: 'manual', name: 'my portfolio' }, cookies);
  expect(res.status).toBe(409);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NAME_TAKEN');
});

// ---------------------------------------------------------------------------
// 151. POST /portfolios with name that slugifies to empty ('!!!') → 400
// ---------------------------------------------------------------------------

it('151: POST /portfolios with name "!!!" → 400 INVALID_NAME', async () => {
  const cookies = await registerAndLogin();

  const res = await portPost({ type: 'manual', name: '!!!' }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('INVALID_NAME');
});

// ---------------------------------------------------------------------------
// 152. POST /portfolios no auth → 401
// ---------------------------------------------------------------------------

it('152: POST /portfolios — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await portPost({ type: 'manual', name: 'Test' });
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 153. GET /portfolios empty user → 200, portfolios=[], meta.total=0
// ---------------------------------------------------------------------------

it('153: GET /portfolios — empty user → 200, portfolios=[], meta.total=0', async () => {
  const cookies = await registerAndLogin();

  const res = await portGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { portfolios: unknown[] }; meta: { total: number } };
  expect(json.data.portfolios).toHaveLength(0);
  expect(json.meta.total).toBe(0);
});

// ---------------------------------------------------------------------------
// 154. GET /portfolios with 2 portfolios → ordered createdAt asc, DTO shape
// ---------------------------------------------------------------------------

it('154: GET /portfolios with 2 portfolios → ordered createdAt asc, each has slug + derived fields all 0', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  await portPost({ type: 'manual', name: 'Alpha' }, cookies);
  await portPost({ type: 'manual', name: 'Beta' }, cookies);

  const res = await portGet('', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { portfolios: Array<Record<string, unknown>> };
    meta: { total: number; limit: number; offset: number };
  };
  expect(json.data.portfolios).toHaveLength(2);
  expect(json.meta.total).toBe(2);

  const [first, second] = json.data.portfolios;
  expect(first!.name).toBe('Alpha');
  expect(first!.slug).toBe('alpha');
  expect(second!.name).toBe('Beta');

  // All derived fields should be 0
  const derived = ['totalValue', 'pnlAllTime', 'pnlAllTimeValue', 'pnl24h', 'pnl24hValue', 'pnl7d', 'pnl7dValue', 'pnl30d', 'pnl30dValue'];
  for (const field of derived) {
    expect(first![field]).toBe(0);
  }
  // netDeposit is a stored column, should be 0 (default)
  expect(first!.netDeposit).toBe(0);
});

// ---------------------------------------------------------------------------
// 155. GET /portfolios with ?limit=1 → 1 item, meta reflects all
// ---------------------------------------------------------------------------

it('155: GET /portfolios ?limit=1 → 1 item returned, meta.total reflects all portfolios', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  await portPost({ type: 'manual', name: 'First' }, cookies);
  await portPost({ type: 'manual', name: 'Second' }, cookies);

  const res = await portGet('?limit=1', cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as {
    data: { portfolios: unknown[] };
    meta: { limit: number; offset: number; total: number };
  };
  expect(json.data.portfolios).toHaveLength(1);
  expect(json.meta.limit).toBe(1);
  expect(json.meta.offset).toBe(0);
  expect(json.meta.total).toBe(2);
});

// ---------------------------------------------------------------------------
// 156. GET /portfolios no auth → 401
// ---------------------------------------------------------------------------

it('156: GET /portfolios — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await portGet('');
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 157. GET /portfolios/:id own → 200 with DTO
// ---------------------------------------------------------------------------

it('157: GET /portfolios/:id — own portfolio → 200 with full DTO', async () => {
  const cookies = await registerAndLogin();

  const createRes = await portPost({ type: 'manual', name: 'My Portfolio' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portGet(`/${portfolioId}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(json.data.portfolio.id).toBe(portfolioId);
  expect(json.data.portfolio.name).toBe('My Portfolio');
  expect(json.data.portfolio.slug).toBe('my-portfolio');
});

// ---------------------------------------------------------------------------
// 158. GET /portfolios/:id another user's → 403
// ---------------------------------------------------------------------------

it('158: GET /portfolios/:id — another user\'s portfolio → 403 FORBIDDEN', async () => {
  const cookiesA = await registerAndLogin('user.a@neonfi.test', 'Test1234', 'User A');
  const cookiesB = await registerAndLogin('user.b@neonfi.test', 'Test1234', 'User B');

  const createRes = await portPost({ type: 'manual', name: 'User A Portfolio' }, cookiesA);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portGet(`/${portfolioId}`, cookiesB);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 159. GET /portfolios/:id non-existent → 403 (uniform)
// ---------------------------------------------------------------------------

it('159: GET /portfolios/:id — non-existent id → 403 FORBIDDEN (uniform, no enumeration leak)', async () => {
  const cookies = await registerAndLogin();

  const res = await portGet('/999999', cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 160. GET /portfolios/:id no auth → 401
// ---------------------------------------------------------------------------

it('160: GET /portfolios/:id — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await portGet('/1');
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 161. PATCH /portfolios/:id rename → 200, slug recomputed
// ---------------------------------------------------------------------------

it('161: PATCH /portfolios/:id rename → 200, name and slug updated', async () => {
  const cookies = await registerAndLogin();

  const createRes = await portPost({ type: 'manual', name: 'Old Name' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portPatch(`/${portfolioId}`, { name: 'New Name' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(json.data.portfolio.name).toBe('New Name');
  expect(json.data.portfolio.slug).toBe('new-name');

  const row = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(row.name).toBe('New Name');
});

// ---------------------------------------------------------------------------
// 162. PATCH /portfolios/:id rename to existing name → 409
// ---------------------------------------------------------------------------

it('162: PATCH /portfolios/:id rename to another owned portfolio\'s name → 409 NAME_TAKEN', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  await portPost({ type: 'manual', name: 'Portfolio A' }, cookies);
  const createRes = await portPost({ type: 'manual', name: 'Portfolio B' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioBId = createJson.data.portfolio.id;

  const res = await portPatch(`/${portfolioBId}`, { name: 'Portfolio A' }, cookies);
  expect(res.status).toBe(409);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('NAME_TAKEN');
});

// ---------------------------------------------------------------------------
// 163. PATCH /portfolios/:id rename to same name (no-op)
// ---------------------------------------------------------------------------

it('163: PATCH /portfolios/:id rename to same name → 200 with current DTO, no DB write', async () => {
  const cookies = await registerAndLogin();

  const createRes = await portPost({ type: 'manual', name: 'My Portfolio' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number; updatedAt: string } } };
  const portfolioId = createJson.data.portfolio.id;
  const originalUpdatedAt = createJson.data.portfolio.updatedAt;

  const res = await portPatch(`/${portfolioId}`, { name: 'My Portfolio' }, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { portfolio: Record<string, unknown> } };
  expect(json.data.portfolio.name).toBe('My Portfolio');
  // updatedAt should be unchanged since no DB write happened
  expect(json.data.portfolio.updatedAt).toBe(originalUpdatedAt);
});

// ---------------------------------------------------------------------------
// 164. PATCH /portfolios/:id unknown field → 400
// ---------------------------------------------------------------------------

it('164: PATCH /portfolios/:id with unknown field "type" → 400 VALIDATION_ERROR', async () => {
  const cookies = await registerAndLogin();

  const createRes = await portPost({ type: 'manual', name: 'Test' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portPatch(`/${portfolioId}`, { name: 'New', type: 'connected' }, cookies);
  expect(res.status).toBe(400);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 165. PATCH /portfolios/:id another user's → 403
// ---------------------------------------------------------------------------

it('165: PATCH /portfolios/:id — another user\'s portfolio → 403 FORBIDDEN', async () => {
  const cookiesA = await registerAndLogin('patch.a@neonfi.test', 'Test1234', 'Patch A');
  const cookiesB = await registerAndLogin('patch.b@neonfi.test', 'Test1234', 'Patch B');

  const createRes = await portPost({ type: 'manual', name: 'User A Portfolio' }, cookiesA);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portPatch(`/${portfolioId}`, { name: 'Hijacked' }, cookiesB);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 166. DELETE /portfolios/:id own → 200, row removed from DB
// ---------------------------------------------------------------------------

it('166: DELETE /portfolios/:id — own portfolio → 200 { ok: true }, row gone from DB', async () => {
  const cookies = await registerAndLogin();

  const createRes = await portPost({ type: 'manual', name: 'To Delete' }, cookies);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portDelete(`/${portfolioId}`, cookies);
  expect(res.status).toBe(200);

  const json = await res.json() as { data: { ok: boolean } };
  expect(json.data.ok).toBe(true);

  const row = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
  expect(row).toBeNull();
});

// ---------------------------------------------------------------------------
// 167. DELETE /portfolios/:id another user's → 403
// ---------------------------------------------------------------------------

it('167: DELETE /portfolios/:id — another user\'s portfolio → 403 FORBIDDEN', async () => {
  const cookiesA = await registerAndLogin('del.a@neonfi.test', 'Test1234', 'Del A');
  const cookiesB = await registerAndLogin('del.b@neonfi.test', 'Test1234', 'Del B');

  const createRes = await portPost({ type: 'manual', name: 'User A Portfolio' }, cookiesA);
  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  const res = await portDelete(`/${portfolioId}`, cookiesB);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 168. DELETE /portfolios/:id non-existent → 403 (uniform)
// ---------------------------------------------------------------------------

it('168: DELETE /portfolios/:id — non-existent id → 403 FORBIDDEN (uniform)', async () => {
  const cookies = await registerAndLogin();

  const res = await portDelete('/999999', cookies);
  expect(res.status).toBe(403);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 169. PATCH /portfolios/:id no auth → 401
// ---------------------------------------------------------------------------

it('169: PATCH /portfolios/:id — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await portPatch('/1', { name: 'New' });
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 170. DELETE /portfolios/:id no auth → 401
// ---------------------------------------------------------------------------

it('170: DELETE /portfolios/:id — no auth → 401 UNAUTHENTICATED', async () => {
  const res = await portDelete('/1');
  expect(res.status).toBe(401);
  const json = await res.json() as { error: { code: string } };
  expect(json.error.code).toBe('UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// 171. Free → Pro upgrade: plan count check uses live plan
// ---------------------------------------------------------------------------

it('171: Free user creates 1 portfolio, upgrades to Pro (direct DB), can now create more', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();

  // Free user: create 1 portfolio (allowed)
  const res1 = await portPost({ type: 'manual', name: 'Free Portfolio' }, cookies);
  expect(res1.status).toBe(201);

  // Still free: 2nd creation blocked
  const res2 = await portPost({ type: 'manual', name: 'Second' }, cookies);
  expect(res2.status).toBe(403);

  // Upgrade to Pro via direct DB (simulates webhook)
  await createProSubForUser(userId);

  // Now can create a 2nd portfolio
  const res3 = await portPost({ type: 'manual', name: 'Pro Portfolio' }, cookies);
  expect(res3.status).toBe(201);

  const count = await prisma.portfolio.count({ where: { userId } });
  expect(count).toBe(2);
});

// ---------------------------------------------------------------------------
// 172. Connected portfolio Solana — round-trip preserves case-sensitive address
// ---------------------------------------------------------------------------

it('172: Connected portfolio Solana — round-trip: case-sensitive address survives DB and read-back', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const solana = await prisma.chain.findUniqueOrThrow({ where: { slug: 'solana' } });

  const solanaAddress = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const createRes = await portPost({
    type: 'connected',
    name: 'Sol Wallet',
    walletAddress: solanaAddress,
    chainId: solana.id,
  }, cookies);
  expect(createRes.status).toBe(201);

  const createJson = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = createJson.data.portfolio.id;

  // Read back via GET /:id
  const getRes = await portGet(`/${portfolioId}`, cookies);
  expect(getRes.status).toBe(200);

  const getJson = await getRes.json() as { data: { portfolio: Record<string, unknown> } };
  expect(getJson.data.portfolio.walletAddress).toBe(solanaAddress);

  // Also verify in DB directly — no case change
  const row = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(row.walletAddress).toBe(solanaAddress);
});

// ---------------------------------------------------------------------------
// Moralis stream integration (tests 173–174)
// ---------------------------------------------------------------------------

it('173: POST /portfolios connected → createStream called once; moralisStreamId persisted in DB', async () => {
  const createStreamMock = vi.mocked(moralisStreams.createStream);
  createStreamMock.mockClear();

  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const ethChain = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const res = await portPost(
    { name: 'Stream Portfolio', type: 'connected', walletAddress: '0xabc1234567890abcdef1234567890abcdef12345', chainId: ethChain.id },
    cookie,
  );
  expect(res.status).toBe(201);
  const body = await res.json() as { data: { portfolio: { id: number } } };
  const portfolioId = body.data.portfolio.id;

  expect(createStreamMock).toHaveBeenCalledTimes(1);

  const dbPortfolio = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(dbPortfolio.moralisStreamId).toBe('mock-stream-123');
});

it('174: DELETE /portfolios/:id connected with moralisStreamId → deleteStream called with stored streamId', async () => {
  const deleteStreamMock = vi.mocked(moralisStreams.deleteStream);
  deleteStreamMock.mockClear();

  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);

  const ethChain = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  // Create connected portfolio (stream registered)
  const createRes = await portPost(
    { name: 'Stream Delete Test', type: 'connected', walletAddress: '0xdead1234567890abcdef1234567890abcdef1234', chainId: ethChain.id },
    cookie,
  );
  expect(createRes.status).toBe(201);
  const body = await createRes.json() as { data: { portfolio: { id: number } } };
  const portfolioId = body.data.portfolio.id;

  deleteStreamMock.mockClear(); // reset after create (no deleteStream called on create)

  const delRes = await portDelete(`/${portfolioId}`, cookie);
  expect(delRes.status).toBe(200);

  expect(deleteStreamMock).toHaveBeenCalledTimes(1);
  expect(deleteStreamMock).toHaveBeenCalledWith('mock-stream-123');
});
