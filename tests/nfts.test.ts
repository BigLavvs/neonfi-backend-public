// Neonfi backend — NFTs module integration tests (Stage 12).
//
// Strategy: real DB + Redis, per-test truncation.
// Tests 281–290. Pro-only endpoints under /portfolios/:id/nfts.

import { it, beforeEach, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

// ---------------------------------------------------------------------------
// Email mock
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
// Moralis streams mock — prevent real HTTP calls when creating portfolios
// ---------------------------------------------------------------------------

vi.mock('../src/lib/moralis-streams-client.js', () => ({
  createStream: vi.fn().mockResolvedValue({ id: 'mock-stream-id' }),
  deleteStream: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_BASE = '/api/v1/auth';
const PORT_BASE = '/api/v1/portfolios';
const TEST_EMAIL = 'nfts.pro@neonfi.test';
const TEST_EMAIL_FREE = 'nfts.free@neonfi.test';
const TEST_PASSWORD = 'Test1234';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authPost(path: string, body: Record<string, unknown>, email = TEST_EMAIL): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(email = TEST_EMAIL): Promise<string> {
  await authPost('/register', { email, password: TEST_PASSWORD, fullName: 'NFT Test User' }, email);
  const res = await authPost('/login', { email, password: TEST_PASSWORD }, email);
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

async function createConnectedPortfolio(userId: number): Promise<number> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } });
  const portfolio = await prisma.portfolio.create({
    data: { userId, name: 'My Wallet', typeId: portfolioType.id, walletAddress: '0xabc123' },
  });
  return portfolio.id;
}

async function createManualPortfolio(userId: number): Promise<number> {
  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const portfolio = await prisma.portfolio.create({
    data: { userId, name: 'Manual Portfolio', typeId: portfolioType.id },
  });
  return portfolio.id;
}

async function seedNft(portfolioId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const nft = await prisma.nft.create({
    data: {
      portfolioId,
      name: overrides.name as string ?? 'Test NFT',
      description: (overrides.description as string | null | undefined) ?? null,
      tokenId: overrides.tokenId as string ?? '1',
      contractAddress: overrides.contractAddress as string ?? '0xcontract1',
      collectionName: overrides.collectionName as string ?? 'TestCollection',
      chain: overrides.chain as string ?? 'eth',
      tokenStandard: overrides.tokenStandard as string ?? null,
      floorPrice: overrides.floorPrice as string ?? null,
      floorPriceUsd: overrides.floorPriceUsd as string ?? null,
      lastSale: overrides.lastSale as string ?? null,
      lastSaleNote: overrides.lastSaleNote as string ?? null,
      rarity: overrides.rarity as string ?? null,
      traits: overrides.traits ?? null,
      possibleSpam: (overrides.possibleSpam as boolean | undefined) ?? false,
    },
  });
  return nft.id;
}

function nftUrl(portfolioId: number, nftId?: number): string {
  const base = `${PORT_BASE}/${portfolioId}/nfts`;
  return nftId !== undefined ? `${base}/${nftId}` : base;
}

async function nftGet(url: string, cookie?: string): Promise<Response> {
  return app.request(url, {
    method: 'GET',
    headers: { ...(cookie ? { Cookie: cookie } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await truncateAllUserData();
  await clearRedisAuthKeys();
});

// ---------------------------------------------------------------------------
// 281: GET /nfts Pro connected → 200, 3 NFTs, newest-first ordering
// ---------------------------------------------------------------------------

it('281: GET /portfolios/:id/nfts Pro connected → 200 with 3 NFTs newest-first', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const id1 = await seedNft(portfolioId, { name: 'First NFT', tokenId: '1', contractAddress: '0xc1' });
  const id2 = await seedNft(portfolioId, { name: 'Second NFT', tokenId: '2', contractAddress: '0xc2' });
  const id3 = await seedNft(portfolioId, { name: 'Third NFT', tokenId: '3', contractAddress: '0xc3' });

  const res = await nftGet(nftUrl(portfolioId), cookie);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { nfts: Array<{ id: number; name: string; owner: string | null }> } };
  expect(body.data.nfts).toHaveLength(3);
  // newest-first: id3 > id2 > id1
  expect(body.data.nfts[0]!.id).toBe(id3);
  expect(body.data.nfts[1]!.id).toBe(id2);
  expect(body.data.nfts[2]!.id).toBe(id1);
  // owner is derived from the connected portfolio's walletAddress ('0xabc123')
  for (const n of body.data.nfts) {
    expect(n.owner).toBe('0xabc123');
  }
});

it('r73-nft-spam: provider-flagged spam NFTs are filtered out of the holdings list; real ones carry possibleSpam:false', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  await seedNft(portfolioId, { name: 'Real NFT', tokenId: 'r1', contractAddress: '0xreal' });
  await seedNft(portfolioId, { name: 'Hefty Presents', tokenId: 's1', contractAddress: '0xspam', possibleSpam: true });
  await seedNft(portfolioId, { name: 'Garbage Bags', tokenId: 's2', contractAddress: '0xspam2', possibleSpam: true });

  const res = await nftGet(nftUrl(portfolioId), cookie);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { nfts: Array<{ name: string; possibleSpam: boolean }> } };

  // retrofit-73 (H13): only the real NFT shows; the two spam airdrops are hidden.
  expect(body.data.nfts).toHaveLength(1);
  expect(body.data.nfts[0]!.name).toBe('Real NFT');
  expect(body.data.nfts[0]!.possibleSpam).toBe(false);
});

// ---------------------------------------------------------------------------
// 282: GET /nfts Free user → 403 PLAN_LIMIT_REACHED
// ---------------------------------------------------------------------------

it('282: GET /portfolios/:id/nfts Free user → 403 PLAN_LIMIT_REACHED', async () => {
  const cookie = await registerAndLogin(TEST_EMAIL_FREE);
  const userId = await getUserId(TEST_EMAIL_FREE);
  await createFreeSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const res = await nftGet(nftUrl(portfolioId), cookie);
  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('PLAN_LIMIT_REACHED');
});

// ---------------------------------------------------------------------------
// 283: GET /nfts manual portfolio (Pro) → 200 with nfts: []
// ---------------------------------------------------------------------------

it('283: GET /portfolios/:id/nfts manual portfolio (Pro) → 200 with empty array', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createManualPortfolio(userId);

  const res = await nftGet(nftUrl(portfolioId), cookie);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { nfts: unknown[] } };
  expect(body.data.nfts).toEqual([]);
});

// ---------------------------------------------------------------------------
// 284: GET /nfts/:id happy path → 200, all 14 fields
// ---------------------------------------------------------------------------

it('284: GET /portfolios/:id/nfts/:nftId Pro → 200 with all 14 fields present', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const nftId = await seedNft(portfolioId, {
    name: 'CryptoPunk #1',
    tokenId: '0001',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    collectionName: 'CryptoPunks',
    chain: 'eth',
    tokenStandard: 'ERC721',
    floorPrice: '50',
    floorPriceUsd: '4750000',
    lastSale: '45',
    lastSaleNote: 'Sold 2 weeks ago',
    rarity: 'legendary',
  });

  const res = await nftGet(nftUrl(portfolioId, nftId), cookie);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { nft: Record<string, unknown> } };
  const nft = body.data.nft;
  // All 14 DTO fields present
  expect(nft.id).toBe(nftId);
  expect(nft.portfolioId).toBe(portfolioId);
  expect(nft.name).toBe('CryptoPunk #1');
  expect(nft.tokenId).toBe('0001');
  expect(nft.contractAddress).toBe('0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb');
  expect(nft.collectionName).toBe('CryptoPunks');
  expect(nft.chain).toBe('eth');
  expect(nft.tokenStandard).toBe('ERC721');
  expect(nft.floorPrice).toBe('50');
  expect(nft.floorPriceUsd).toBe('4750000');
  expect(nft.lastSale).toBe('45');
  expect(nft.lastSaleNote).toBe('Sold 2 weeks ago');
  expect(nft.rarity).toBe('legendary');
  expect('createdAt' in nft).toBe(true);
  // owner is derived from the connected portfolio's walletAddress ('0xabc123')
  expect(nft.owner).toBe('0xabc123');
});

// ---------------------------------------------------------------------------
// 285: GET /nfts/:id another user's portfolio → 403 FORBIDDEN
// ---------------------------------------------------------------------------

it("285: GET /portfolios/:id/nfts/:nftId accessing another user's portfolio → 403 FORBIDDEN", async () => {
  // User A creates portfolio + NFT
  const cookieA = await registerAndLogin();
  const userIdA = await getUserId();
  await createProSubForUser(userIdA);
  const portfolioA = await createConnectedPortfolio(userIdA);
  const nftId = await seedNft(portfolioA);

  // User B tries to access it
  const cookieB = await registerAndLogin(TEST_EMAIL_FREE);
  const userIdB = await getUserId(TEST_EMAIL_FREE);
  await createProSubForUser(userIdB);

  const res = await nftGet(nftUrl(portfolioA, nftId), cookieB);
  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 286: GET /nfts/:id non-existent → 404 NFT_NOT_FOUND
// ---------------------------------------------------------------------------

it('286: GET /portfolios/:id/nfts/:nftId non-existent → 404 NFT_NOT_FOUND', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const res = await nftGet(nftUrl(portfolioId, 999999), cookie);
  expect(res.status).toBe(404);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('NFT_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 287: GET /nfts/:id Free user → 403 PLAN_LIMIT_REACHED
// ---------------------------------------------------------------------------

it('287: GET /portfolios/:id/nfts/:nftId Free user → 403 PLAN_LIMIT_REACHED', async () => {
  const cookie = await registerAndLogin(TEST_EMAIL_FREE);
  const userId = await getUserId(TEST_EMAIL_FREE);
  await createFreeSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);
  const nftId = await seedNft(portfolioId);

  const res = await nftGet(nftUrl(portfolioId, nftId), cookie);
  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('PLAN_LIMIT_REACHED');
});

// ---------------------------------------------------------------------------
// 288: Marketplace fields populated → traits is parsed JSON
// ---------------------------------------------------------------------------

it('288: GET /portfolios/:id/nfts Pro with traits JSON → traits parsed as object', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const traitsValue = [{ trait_type: 'Background', value: 'Blue' }, { trait_type: 'Eyes', value: 'Laser' }];
  const nftId = await seedNft(portfolioId, {
    name: 'NFT with Traits',
    tokenId: '42',
    contractAddress: '0xtraitcontract',
    traits: traitsValue,
  });

  const res = await nftGet(nftUrl(portfolioId, nftId), cookie);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { nft: { traits: unknown } } };
  expect(body.data.nft.traits).toEqual(traitsValue);
});

// ---------------------------------------------------------------------------
// 291: retrofit-51 — DTO exposes the collectible description (set + null cases)
// ---------------------------------------------------------------------------

it('291: GET /portfolios/:id/nfts/:nftId returns description when set, null when absent', async () => {
  const cookie = await registerAndLogin();
  const userId = await getUserId();
  await createProSubForUser(userId);
  const portfolioId = await createConnectedPortfolio(userId);

  const withDesc = await seedNft(portfolioId, {
    tokenId: 'd1', contractAddress: '0xdesc1', description: 'A legendary on-chain collectible.',
  });
  const noDesc = await seedNft(portfolioId, { tokenId: 'd2', contractAddress: '0xdesc2' });

  const r1 = await nftGet(nftUrl(portfolioId, withDesc), cookie);
  expect(r1.status).toBe(200);
  expect(((await r1.json()) as { data: { nft: { description: string | null } } }).data.nft.description)
    .toBe('A legendary on-chain collectible.');

  const r2 = await nftGet(nftUrl(portfolioId, noDesc), cookie);
  expect(r2.status).toBe(200);
  expect(((await r2.json()) as { data: { nft: { description: string | null } } }).data.nft.description)
    .toBeNull();
});

// ---------------------------------------------------------------------------
// 289: GET /nfts no auth → 401
// ---------------------------------------------------------------------------

it('289: GET /portfolios/:id/nfts no auth → 401', async () => {
  const res = await nftGet(nftUrl(1));
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 290: GET /nfts/:id no auth → 401
// ---------------------------------------------------------------------------

it('290: GET /portfolios/:id/nfts/:nftId no auth → 401', async () => {
  const res = await nftGet(nftUrl(1, 1));
  expect(res.status).toBe(401);
});
