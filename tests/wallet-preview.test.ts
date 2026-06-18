// Neonfi backend — connected-wallet preview endpoint + initial holdings sync (retrofit-47).
//
// Integration (real DB + Redis). The read-side provider chain (wallet-data/index.js) is
// MOCKED so we control the summary deterministically — the provider parsers + orchestrator
// themselves are covered in wallet-data.test.ts. This file exercises (a) the preview route
// wiring (found/empty/invalid/invalid-chain/validation) and (b) syncConnectedHoldings:
// catalog resolve + auto-listing of non-catalog tokens + opening-position seeding.

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

vi.mock('../src/lib/moralis-streams-client.js', () => ({
  createStream: vi.fn().mockResolvedValue({ id: 'mock-stream-preview' }),
  deleteStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// Controllable read-side provider chain. The controller imports previewWallet and
// syncConnectedHoldings imports fetchWalletSummary — both from this module.
const { previewWalletMock, fetchWalletSummaryMock } = vi.hoisted(() => ({
  previewWalletMock: vi.fn(),
  fetchWalletSummaryMock: vi.fn(),
}));
vi.mock('../src/modules/wallet-data/index.js', () => ({
  previewWallet: previewWalletMock,
  fetchWalletSummary: fetchWalletSummaryMock,
}));

const AUTH_BASE = '/api/v1/auth';
const PORT_BASE = '/api/v1/portfolios';
const TEST_EMAIL = 'wallet.preview@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const VALID_EVM = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
const AUTO_SYMBOL = 'ZZAUTO47';
// retrofit-48: catalog rows pre-seeded / auto-listed by the sync-resolution cases below.
// Cleared each run (after truncate drops their asset FKs) so resolution starts clean.
const SYNC_TEST_SYMBOLS = [AUTO_SYMBOL, 'ZZEXIST48', 'ZZWALLET48', 'ZZBACKFILL48', 'ZZCOLLIDE48'];

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(): Promise<{ cookie: string; userId: number }> {
  await authPost('/register', { email: TEST_EMAIL, password: TEST_PASSWORD, fullName: 'Wallet Preview' });
  const res = await authPost('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const cookie = `session=${cookieValue(res, 'session')!}`;
  const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
  // eth is a free-tier chain, but seed an explicit free sub so getEffectivePlan is stable.
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'free' } });
  const status = await prisma.subscriptionStatus.findUniqueOrThrow({ where: { name: 'active' } });
  await prisma.subscription.create({
    data: { userId: user.id, planId: plan.id, statusId: status.id, currentPeriodStart: new Date('2026-06-01T00:00:00Z'), currentPeriodEnd: null },
  });
  return { cookie, userId: user.id };
}

async function portPost(path: string, body: Record<string, unknown>, cookie: string): Promise<Response> {
  return app.request(`${PORT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  // truncate first (clears assets so the auto-listed token has no FK refs), then drop the
  // auto-listed token so each run re-creates it from scratch.
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYNC_TEST_SYMBOLS } } });
  await clearRedisAuthKeys();
  previewWalletMock.mockReset();
  fetchWalletSummaryMock.mockReset();
  fetchWalletSummaryMock.mockResolvedValue(null); // default: connected create seeds nothing
});

afterAll(async () => {
  // Leave the catalog clean: clear the last test's assets, then the auto-listed tokens.
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYNC_TEST_SYMBOLS } } });
});

// ---------------------------------------------------------------------------
// POST /portfolios/wallet/preview
// ---------------------------------------------------------------------------

it('399: preview found → 200 with the provider summary in the envelope', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const summary = {
    nativeSymbol: 'ETH', nativeBalance: 1.5, totalUsd: 4600, tokenCount: 2,
    tokens: [{ symbol: 'ETH', name: 'Ether', contractAddress: null, balance: 1.5, decimals: 18, usdPrice: 3000, usdValue: 4500, isNative: true }],
    provider: 'moralis',
  };
  previewWalletMock.mockResolvedValue({ status: 'found', summary });

  const res = await portPost('/wallet/preview', { walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.status).toBe('found');
  expect(json.data.summary.provider).toBe('moralis');
  expect(json.data.summary.totalUsd).toBe(4600);
  // Address + chain forwarded to the orchestrator.
  expect(previewWalletMock).toHaveBeenCalledWith(VALID_EVM, expect.objectContaining({ slug: 'eth' }));
});

it('400: preview empty → 200 status=empty, no summary', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  previewWalletMock.mockResolvedValue({ status: 'empty' });

  const res = await portPost('/wallet/preview', { walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.status).toBe('empty');
  expect(json.data.summary).toBeUndefined();
});

it('401: preview invalid address → 200 status=invalid', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  previewWalletMock.mockResolvedValue({ status: 'invalid' });

  const res = await portPost('/wallet/preview', { walletAddress: 'not-a-wallet', chainId: eth.id }, cookie);
  expect(res.status).toBe(200);
  expect((await res.json()).data.status).toBe('invalid');
});

it('402: preview non-existent chainId → 400 INVALID_CHAIN, orchestrator never called', async () => {
  const { cookie } = await registerAndLogin();
  const res = await portPost('/wallet/preview', { walletAddress: VALID_EVM, chainId: 999999 }, cookie);
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('INVALID_CHAIN');
  expect(previewWalletMock).not.toHaveBeenCalled();
});

it('403: preview missing fields → 400 VALIDATION_ERROR', async () => {
  const { cookie } = await registerAndLogin();
  const res = await portPost('/wallet/preview', { walletAddress: VALID_EVM }, cookie);
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
});

it('404: preview requires auth → 401 without a session', async () => {
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const res = await app.request(`${PORT_BASE}/wallet/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: VALID_EVM, chainId: eth.id }),
  });
  expect(res.status).toBe(401);
  expect(previewWalletMock).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Initial holdings sync on connected create
// ---------------------------------------------------------------------------

it('405: connected create seeds catalog + auto-listed holdings, opening positions, netDeposit', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalogToken = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // Summary: one EXISTING catalog token + one NON-catalog token (must be auto-listed).
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalogToken.symbol,
    nativeBalance: 2,
    totalUsd: 3050,
    tokenCount: 2,
    tokens: [
      { symbol: catalogToken.symbol, name: catalogToken.name, contractAddress: null, balance: 2, decimals: 18, usdPrice: 1500, usdValue: 3000, isNative: true },
      { symbol: AUTO_SYMBOL, name: 'Auto Listed', contractAddress: '0xauto', balance: 10, decimals: 18, usdPrice: 5, usdValue: 50, isNative: false },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Connected Sync', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // Non-catalog token was auto-listed from provider metadata.
  const auto = await prisma.token.findUnique({ where: { symbol: AUTO_SYMBOL } });
  expect(auto).not.toBeNull();
  expect(Number(auto!.currentPrice)).toBe(5);
  expect(auto!.rank).toBeNull();
  // retrofit-48: an auto-listed row is flagged + carries the provider's (lower-cased) contract.
  expect(auto!.autoListed).toBe(true);
  expect(auto!.contractAddress).toBe('0xauto');

  // An asset row + a native `buy` transaction exist for BOTH holdings.
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(2);
  const txns = await prisma.transaction.findMany({ where: { portfolioId } });
  expect(txns).toHaveLength(2);

  // Opening positions valued ≈ provider summary → portfolio netDeposit ≈ Σ cost basis.
  const portfolio = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(Number(portfolio.netDeposit)).toBeCloseTo(3050, 2);

  // Existing stream registration is unchanged (still wired).
  expect(portfolio.moralisStreamId).toBe('mock-stream-preview');
});

it('406: connected create with an empty wallet → portfolio still created, no assets', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  fetchWalletSummaryMock.mockResolvedValue(null);

  const res = await portPost('', { name: 'Empty Connected', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;
  expect(await prisma.asset.count({ where: { portfolioId } })).toBe(0);
});

it('407: a single bad-token seed does not abort the rest of the sync', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalogToken = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalogToken.symbol,
    nativeBalance: 1,
    totalUsd: 1500,
    tokenCount: 2,
    tokens: [
      // A symbol longer than VarChar(20) → token.upsert throws → this one is skipped.
      { symbol: 'WAYTOOLONGSYMBOLNAME1234567890', name: 'Too Long', contractAddress: '0xbad', balance: 5, decimals: 18, usdPrice: 1, usdValue: 5, isNative: false },
      { symbol: catalogToken.symbol, name: catalogToken.name, contractAddress: null, balance: 1, decimals: 18, usdPrice: 1500, usdValue: 1500, isNative: true },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Partial Sync', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // The good catalog token still seeded despite the bad one failing.
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// retrofit-48 — contract-first resolution, backfill, collision
// ---------------------------------------------------------------------------

it('408: sync resolves a wallet token to an existing row by CONTRACT (no new symbol row)', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  // An existing row carrying a contract. The wallet token has a DIFFERENT symbol but the
  // SAME contract (different case) → it must resolve by contract to this row, not auto-list.
  const existing = await prisma.token.create({
    data: { symbol: 'ZZEXIST48', name: 'Existing', currentPrice: '7', contractAddress: '0xdeadbeef48' },
  });
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 100, tokenCount: 1,
    tokens: [
      { symbol: 'ZZWALLET48', name: 'Wallet Alias', contractAddress: '0xDEADBEEF48', balance: 4, decimals: 18, usdPrice: 25, usdValue: 100, isNative: false },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Contract Match', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // No new row for the wallet's alias symbol; the asset is seeded against the existing row.
  expect(await prisma.token.findUnique({ where: { symbol: 'ZZWALLET48' } })).toBeNull();
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(1);
  expect(assets[0]!.tokenId).toBe(existing.id);
  // The existing row's contract is untouched (it already had one).
  const after = await prisma.token.findUniqueOrThrow({ where: { id: existing.id } });
  expect(after.contractAddress).toBe('0xdeadbeef48');
});

it('409: sync backfills contractAddress on a symbol match when the row had none', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const existing = await prisma.token.create({
    data: { symbol: 'ZZBACKFILL48', name: 'Backfill Me', currentPrice: '3', contractAddress: null },
  });
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 30, tokenCount: 1,
    tokens: [
      { symbol: 'ZZBACKFILL48', name: 'Backfill Me', contractAddress: '0xBackFill48', balance: 10, decimals: 18, usdPrice: 3, usdValue: 30, isNative: false },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Backfill', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // Matched the existing row (no duplicate) and recorded the contract, lower-cased.
  expect(await prisma.token.count({ where: { symbol: 'ZZBACKFILL48' } })).toBe(1);
  const after = await prisma.token.findUniqueOrThrow({ where: { id: existing.id } });
  expect(after.contractAddress).toBe('0xbackfill48');
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(1);
  expect(assets[0]!.tokenId).toBe(existing.id);
});

it('410: a same-ticker / different-contract collision maps to the existing row + warns, no dup, no throw', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const existing = await prisma.token.create({
    data: { symbol: 'ZZCOLLIDE48', name: 'Original Project', currentPrice: '9', contractAddress: '0xaaa111' },
  });
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 90, tokenCount: 1,
    tokens: [
      { symbol: 'ZZCOLLIDE48', name: 'Impostor Project', contractAddress: '0xBBB222', balance: 10, decimals: 18, usdPrice: 9, usdValue: 90, isNative: false },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Collision', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201); // never throws
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // Single row (no duplicate); existing contract untouched; collision logged.
  expect(await prisma.token.count({ where: { symbol: 'ZZCOLLIDE48' } })).toBe(1);
  const after = await prisma.token.findUniqueOrThrow({ where: { id: existing.id } });
  expect(after.contractAddress).toBe('0xaaa111');
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(1);
  expect(assets[0]!.tokenId).toBe(existing.id);
  expect(warn).toHaveBeenCalledWith(
    '[wallet-sync] ticker collision',
    expect.objectContaining({ symbol: 'ZZCOLLIDE48', existing: '0xaaa111', incoming: '0xbbb222' }),
  );
  warn.mockRestore();
});
