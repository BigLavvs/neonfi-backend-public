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

// retrofit-47: connected create now runs an initial holdings sync that would otherwise
// hit the real read-side providers over the network. Stub it to a no-op so these
// pre-retrofit-47 create tests stay hermetic (the sync itself is covered in
// wallet-data.test.ts / wallet-preview.test.ts).
vi.mock('../src/modules/wallet-data/sync.js', () => ({
  syncConnectedHoldings: vi.fn().mockResolvedValue(undefined),
  // retrofit-49: transactions.controller imports this from sync.js; stub it so the mocked
  // module is complete (these create tests never hit the sync-more endpoint).
  importMoreTransfers: vi.fn().mockResolvedValue({ imported: 0, nextCursor: null }),
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
// 140. POST /portfolios manual — `assets[]` now accepted (retrofit-8); strict still
// rejects genuinely unknown fields.
// ---------------------------------------------------------------------------

it('140: POST /portfolios manual — assets[] accepted (retrofit-8); strict still rejects unknown fields', async () => {
  const cookies = await registerAndLogin();

  // retrofit-8: `assets` is now a recognized optional field — an empty array is accepted
  // (no seeds → falls through to the plain single-insert path).
  const okRes = await portPost({ type: 'manual', name: 'Has Empty Assets', assets: [] }, cookies);
  expect(okRes.status).toBe(201);

  // strict mode still rejects a genuinely unknown field
  const badRes = await portPost({ type: 'manual', name: 'Bogus', bogus: true }, cookies);
  expect(badRes.status).toBe(400);
  const json = await badRes.json() as { error: { code: string } };
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

  // Non-short-term derived fields are 0 for an empty manual portfolio (incl. retrofit-27
  // average-cost fields). pnlAllTime* are the netDeposit-based path (manual) → 0 with no deposits.
  const zeroFields = [
    'totalValue', 'pnlAllTime', 'pnlAllTimeValue',
    'unrealizedPnlValue', 'unrealizedPnlPct', 'realizedPnlValue', 'allTimePnlValue',
  ];
  for (const field of zeroFields) {
    expect(first![field]).toBe(0);
  }
  // retrofit-79 (§2/D1): the short-term windows are null ("—") with no snapshot baseline, not 0.
  for (const field of ['pnl24h', 'pnl24hValue', 'pnl7d', 'pnl7dValue', 'pnl30d', 'pnl30dValue']) {
    expect(first![field]).toBeNull();
  }
  // netDeposit is a stored column, should be 0 (default)
  expect(first!.netDeposit).toBe(0);
});

// ---------------------------------------------------------------------------
// retrofit-76 — a MANUAL portfolio now derives 24h/7d/30d PnL from BalanceSnapshot
// deltas (was hardcoded 0). Surfaced on the GET /portfolios derived fields; the
// cost-basis all-time path is unchanged.
// ---------------------------------------------------------------------------

it('r76: manual portfolio 24h/7d/30d = current value − the snapshot nearest N days ago (all-time path unchanged)', async () => {
  const cookies = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });

  // Manual portfolio holding BTC 1.0 → current value = the seeded BTC price (93000). No avgCost
  // seeded (cost-unknown), so the cost-basis all-time stays 0 — only the windows come from history.
  const p = await prisma.portfolio.create({ data: { userId, name: 'Hist', typeId: type.id } });
  await prisma.asset.create({ data: { portfolioId: p.id, tokenId: btc.id, balance: '1' } });

  // Snapshots nearest ~1d / ~7d / ~30d ago, each within findSnapshotNearDaysAgo's tolerance.
  const ymdAgo = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const seedSnap = (n: number, value: number): Promise<unknown> =>
    prisma.balanceSnapshot.create({
      data: { portfolioId: p.id, userId, snapshotDate: new Date(`${ymdAgo(n)}T00:00:00.000Z`), value: value.toString() },
    });
  await seedSnap(2, 80000); // ~24h baseline
  await seedSnap(7, 70000);
  await seedSnap(30, 60000);

  const res = await portGet('', cookies);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { portfolios: Array<Record<string, unknown>> } };
  const row = json.data.portfolios.find((r) => r.name === 'Hist')!;

  // retrofit-76: each window = current (93000) − the snapshot nearest N days ago. The DTO does
  // NOT round derived fields, so the value deltas are exact integers.
  expect(row.totalValue).toBeCloseTo(93000, 2);
  expect(row.pnl24hValue).toBe(13000); // 93000 − 80000
  expect(row.pnl24h).toBe(16.25); // 13000 / 80000 * 100
  expect(row.pnl7dValue).toBe(23000); // 93000 − 70000
  expect(row.pnl30dValue).toBe(33000); // 93000 − 60000
  // The cost-basis all-time path is untouched: no cost tracked → 0.
  expect(row.allTimePnlValue).toBe(0);
});

// ---------------------------------------------------------------------------
// 155. GET /portfolios with ?limit=1 → 1 item, meta reflects all
// ---------------------------------------------------------------------------
