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
import { redis } from '../src/lib/redis.js';
import { cookieValue, clearRedisAuthKeys, truncateAllUserData } from './helpers.js';

vi.mock('../src/lib/moralis-streams-client.js', () => ({
  createStream: vi.fn().mockResolvedValue({ id: 'mock-stream-preview' }),
  deleteStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// Controllable read-side provider chain. The controller imports previewWallet; the sync
// (sync.ts) imports fetchWalletSummary + fetchTransferPage + fetchNftHoldings — all from
// this module, so mock all four (retrofit-49 added the history + nft-holdings reads).
// retrofit-56 added fetchTransactionCount + fetchValueHistory (connected count + snapshot
// backfill); default them to null so the sync's best-effort calls are clean no-ops here.
const {
  previewWalletMock,
  fetchWalletSummaryMock,
  fetchTransferPageMock,
  fetchNftHoldingsMock,
  fetchWalletPnlMock,
} = vi.hoisted(() => ({
  previewWalletMock: vi.fn(),
  fetchWalletSummaryMock: vi.fn(),
  fetchTransferPageMock: vi.fn(),
  fetchNftHoldingsMock: vi.fn(),
  // retrofit-79 (§1): the sync now also fetches provider PnL; default null (no cost basis) so the
  // existing wiring tests stay deterministic. The cost-basis-applied case overrides it per-test.
  fetchWalletPnlMock: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/modules/wallet-data/index.js', () => ({
  previewWallet: previewWalletMock,
  fetchWalletSummary: fetchWalletSummaryMock,
  fetchTransferPage: fetchTransferPageMock,
  fetchNftHoldings: fetchNftHoldingsMock,
  fetchTransactionCount: vi.fn().mockResolvedValue(null),
  fetchValueHistory: vi.fn().mockResolvedValue(null),
  fetchWalletPnl: fetchWalletPnlMock,
  // retrofit-84 (H13): importNftHoldings now pulls the cross-provider spam-contract DB; an empty
  // set keeps these wiring tests offline (the spam verdict degrades to provider-flag-OR-heuristic).
  fetchSpamContracts: vi.fn().mockResolvedValue(new Set()),
  // retrofit-86 (H13.1): importNftHoldings also unions the GoldRush per-wallet spam set; empty too.
  fetchWalletSpamContracts: vi.fn().mockResolvedValue(new Set()),
}));

const AUTH_BASE = '/api/v1/auth';
const PORT_BASE = '/api/v1/portfolios';
const TEST_EMAIL = 'wallet.preview@neonfi.test';
const TEST_PASSWORD = 'Test1234';
const VALID_EVM = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
const AUTO_SYMBOL = 'ZZAUTO47';
// retrofit-48: catalog rows pre-seeded / auto-listed by the sync-resolution cases below.
// Cleared each run (after truncate drops their asset FKs) so resolution starts clean.
const SYNC_TEST_SYMBOLS = [AUTO_SYMBOL, 'ZZEXIST48', 'ZZWALLET48', 'ZZBACKFILL48', 'ZZCOLLIDE48', 'WAYTOOLONGSYMBOLNAME1234567890', 'ZZPNL79A', 'ZZPNL79B'];

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

// retrofit-65: flip the registered user's subscription to Pro so the 5-min (not 24h) cooldown
// applies. registerAndLogin seeds a free sub; userId is unique on subscription.
async function setUserPro(userId: number): Promise<void> {
  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  await prisma.subscription.update({ where: { userId }, data: { planId: proPlan.id } });
}

async function portPost(path: string, body: Record<string, unknown>, cookie: string): Promise<Response> {
  return app.request(`${PORT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function syncMoreGet(portfolioId: number, cookie: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}/transactions/sync-more`, {
    headers: { Cookie: cookie },
  });
}

function resyncPost(portfolioId: number, cookie: string): Promise<Response> {
  return app.request(`${PORT_BASE}/${portfolioId}/resync`, { method: 'POST', headers: { Cookie: cookie } });
}

function overviewGet(cookie: string): Promise<Response> {
  return app.request('/api/v1/overview', { headers: { Cookie: cookie } });
}

beforeEach(async () => {
  // truncate first (clears assets so the auto-listed token has no FK refs), then drop the
  // auto-listed token so each run re-creates it from scratch.
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYNC_TEST_SYMBOLS } } });
  await clearRedisAuthKeys();
  // truncateAllUserData flushes portfolio_pnl/analytics but not overview:* — clear it so the
  // overview count test (416) can't get a stale per-user hit (userIds repeat after truncate).
  const overviewKeys = await redis.keys('overview:*');
  if (overviewKeys.length > 0) await redis.del(overviewKeys);
  // retrofit-65: resync cooldown keys (`resync_cooldown:<portfolioId>`) survive truncate and
  // portfolio IDs repeat across tests — flush so a prior test's cooldown can't 429 a later one.
  const cooldownKeys = await redis.keys('resync_cooldown:*');
  if (cooldownKeys.length > 0) await redis.del(cooldownKeys);
  previewWalletMock.mockReset();
  fetchWalletSummaryMock.mockReset();
  fetchTransferPageMock.mockReset();
  fetchNftHoldingsMock.mockReset();
  fetchWalletPnlMock.mockReset();
  fetchWalletSummaryMock.mockResolvedValue(null); // default: connected create seeds nothing
  fetchTransferPageMock.mockResolvedValue(null); // default: no transfer history
  fetchNftHoldingsMock.mockResolvedValue(null); // default: no current nft holdings
  fetchWalletPnlMock.mockResolvedValue(null); // default: no provider PnL (cost-unknown)
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

it('405: connected create sets balances DIRECTLY from the provider summary (no opening lots) — retrofit-58 Part 1', async () => {
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

  // retrofit-58: an Asset row exists for BOTH holdings with the EXACT provider balance, and
  // cost-basis fields are cleared (a windowed import can't trust them — connected PnL comes
  // from snapshots). There is NO opening-lot transaction (none — there were no transfers).
  const assets = await prisma.asset.findMany({ where: { portfolioId }, include: { token: true } });
  expect(assets).toHaveLength(2);
  const catAsset = assets.find((a) => a.token.symbol === catalogToken.symbol)!;
  const autoAsset = assets.find((a) => a.token.symbol === AUTO_SYMBOL)!;
  expect(Number(catAsset.balance)).toBeCloseTo(2, 8);
  expect(Number(autoAsset.balance)).toBeCloseTo(10, 8);
  expect(catAsset.avgCost).toBeNull();
  expect(Number(catAsset.costBasis)).toBe(0);

  const txns = await prisma.transaction.findMany({ where: { portfolioId } });
  expect(txns).toHaveLength(0); // no transfer history → no feed rows, and NO opening lots

  // Connected cost basis is N/A, so netDeposit is not maintained from a windowed import.
  const portfolio = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(Number(portfolio.netDeposit)).toBe(0);

  // Existing stream registration is unchanged (still wired).
  expect(portfolio.moralisStreamId).toBe('mock-stream-preview');
});

it('r79: provider PnL writes per-token cost basis on sync (cost-tracked → avgCost/costBasis/realized; not-in-PnL → cost-unknown null)', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  // Held: token A (in the provider PnL → cost-tracked) + token B (NOT in the PnL → cost-unknown).
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH',
    nativeBalance: 0,
    totalUsd: 90,
    tokenCount: 2,
    tokens: [
      { symbol: 'ZZPNL79A', name: 'Cost Tracked', contractAddress: '0xpnla', balance: 5, decimals: 18, usdPrice: 10, usdValue: 50, isNative: false },
      { symbol: 'ZZPNL79B', name: 'Cost Unknown', contractAddress: '0xpnlb', balance: 4, decimals: 18, usdPrice: 10, usdValue: 40, isNative: false },
    ],
    provider: 'moralis',
  });
  // GoldRush-style PnL: only token A has a cost basis (avg buy 8/unit, realized +12.5). The
  // orchestrator keys items by on-chain token_address (contractAddress).
  fetchWalletPnlMock.mockResolvedValue({
    provider: 'goldrush',
    tokens: [
      { symbol: null, contractAddress: '0xpnla', avgCost: 8, realizedPnlUsd: 12.5, unrealizedPnlUsd: 0 },
    ],
  });

  const res = await portPost('', { name: 'PnL Sync', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  const assets = await prisma.asset.findMany({ where: { portfolioId }, include: { token: true } });
  const a = assets.find((x) => x.token.symbol === 'ZZPNL79A')!;
  const b = assets.find((x) => x.token.symbol === 'ZZPNL79B')!;
  // Token A got the provider cost basis: avgCost 8, costBasis = 8 × 5 = 40, realized 12.5.
  expect(Number(a.avgCost)).toBeCloseTo(8, 8);
  expect(Number(a.costBasis)).toBeCloseTo(40, 8);
  expect(Number(a.realizedPnl)).toBeCloseTo(12.5, 8);
  // Token B was not in the PnL → genuinely cost-unknown → stays null/0 ("—").
  expect(b.avgCost).toBeNull();
  expect(Number(b.costBasis)).toBe(0);
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

it('407: an over-long token symbol now AUTO-LISTS instead of being skipped — retrofit-58 Part 4', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalogToken = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // A scam name well over the old 255-char bound (proves the name → TEXT widening).
  const longName = 'Visit https://claim-your-airdrop.example.com/redeem?ref=0xdeadbeefcafebabe to claim. '.repeat(5);
  expect(longName.length).toBeGreaterThan(255);

  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalogToken.symbol,
    nativeBalance: 1,
    totalUsd: 1500,
    tokenCount: 2,
    tokens: [
      // 30-char symbol + >255-char name: pre-Part-4 these overflowed VarChar(20)/VarChar(255) so
      // token.create threw and the token was silently skipped. Now they auto-list cleanly.
      { symbol: 'WAYTOOLONGSYMBOLNAME1234567890', name: longName, contractAddress: '0xbad', balance: 5, decimals: 18, usdPrice: 1, usdValue: 5, isNative: false },
      { symbol: catalogToken.symbol, name: catalogToken.name, contractAddress: null, balance: 1, decimals: 18, usdPrice: 1500, usdValue: 1500, isNative: true },
    ],
    provider: 'moralis',
  });

  const res = await portPost('', { name: 'Partial Sync', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // BOTH tokens now seed: the catalog token AND the previously-overflowing one (auto-listed).
  const assets = await prisma.asset.findMany({ where: { portfolioId } });
  expect(assets).toHaveLength(2);
  const longTok = await prisma.token.findUnique({ where: { symbol: 'WAYTOOLONGSYMBOLNAME1234567890' } });
  expect(longTok).not.toBeNull();
  expect(longTok!.autoListed).toBe(true);
  expect(longTok!.name.length).toBeGreaterThan(255); // the long name persisted (TEXT column)
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

// ---------------------------------------------------------------------------
// retrofit-49 — real transfer-history import + NFT + sync-more + overview count
// ---------------------------------------------------------------------------

it('413: connected create imports REAL transfers (feed) + sets balance DIRECTLY from the provider summary — retrofit-58', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // The wallet currently holds 5 (provider summary); history shows +2.1234567891 in, -0.5 out.
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 5, totalUsd: 5000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 5, decimals: 18, usdPrice: 1000, usdValue: 5000, isNative: true }],
    provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({
    transfers: [
      // intentionally newest-first (provider returns DESC) — the importer replays oldest→newest
      { type: 'native', direction: 'out', hash: '0xbbb413', from: '0xwallet413', to: '0xrecv413', symbol: catalog.symbol, name: catalog.name, contractAddress: null, amount: 0.5, usdValue: 600, gasFee: null, timestamp: '2026-01-12T00:00:00.000Z', logoUrl: null, nftTokenId: null, collectionName: null },
      { type: 'native', direction: 'in', hash: '0xaaa413', from: '0xsender413', to: '0xwallet413', symbol: catalog.symbol, name: catalog.name, contractAddress: null, amount: 2.1234567891, usdValue: 2000, gasFee: 0.005, timestamp: '2026-01-10T00:00:00.000Z', logoUrl: null, nftTokenId: null, collectionName: null },
    ],
    nextCursor: 'CURSOR2', totalCount: 42,
  });

  const res = await portPost('', { name: 'Real History', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // retrofit-58: the two imported transfers are recorded as the activity FEED — no opening
  // lot is seeded anymore, so there are exactly 2 transactions.
  const txns = await prisma.transaction.findMany({
    where: { portfolioId },
    include: { nativeDetail: true, direction: true, type: true },
    orderBy: { timestamp: 'asc' },
  });
  expect(txns).toHaveLength(2);

  // The 'in' transfer kept its REAL hash / from / to / timestamp / gas / historical usdValue.
  const inTx = txns.find((t) => t.transactionHash === '0xaaa413')!;
  expect(inTx).toBeDefined();
  expect(inTx.direction.name).toBe('buy');
  expect(inTx.from).toBe('0xsender413');
  expect(inTx.to).toBe('0xwallet413');
  expect(inTx.timestamp.toISOString()).toBe('2026-01-10T00:00:00.000Z');
  expect(Number(inTx.gasFee)).toBe(0.005);
  expect(Number(inTx.nativeDetail!.usdValue)).toBe(2000);
  // amount trimmed to Decimal(20,8): 2.1234567891 → 2.12345679 (≤ 8 dp, no overflow).
  expect(inTx.nativeDetail!.amount.toString()).toBe('2.12345679');

  const outTx = txns.find((t) => t.transactionHash === '0xbbb413')!;
  expect(outTx.direction.name).toBe('sell');

  // Balance == provider current balance (5) — set DIRECTLY from the summary, not reconstructed
  // from the windowed transfer set (whose net here is only +1.62345679).
  const asset = await prisma.asset.findFirstOrThrow({ where: { portfolioId, tokenId: catalog.id } });
  expect(Number(asset.balance)).toBeCloseTo(5, 6);

  // Cursor + provider total persisted for "load more" / the overview count.
  const portfolio = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  expect(portfolio.syncCursor).toBe('CURSOR2');
  expect(portfolio.externalTxCount).toBe(42);
});

it('414: an NFT transfer creates an nft transaction + an Nft row; current NFT holdings imported', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: null, tokenCount: 0, tokens: [], provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({
    transfers: [
      { type: 'nft', direction: 'in', hash: '0xnft414', from: '0xsender414', to: '0xwallet414', symbol: null, name: 'Cool Ape #7', contractAddress: '0xNFTCONTRACT414', amount: 1, usdValue: null, gasFee: null, timestamp: '2026-02-01T00:00:00.000Z', logoUrl: 'http://img/7', nftTokenId: '7', collectionName: 'Cool Apes' },
    ],
    nextCursor: null, totalCount: null,
  });
  // A current holding that predates the transfer window (retrofit-51: carries a description).
  fetchNftHoldingsMock.mockResolvedValue([
    { contractAddress: '0xheldcontract414', tokenId: '99', name: 'Held One', description: 'A rare held collectible.', collectionName: 'Held Coll', logoUrl: 'http://img/99', tokenStandard: 'ERC721' },
  ]);

  const res = await portPost('', { name: 'NFT Wallet', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(res.status).toBe(201);
  const portfolioId = (await res.json()).data.portfolio.id as number;

  // The NFT transfer is recorded as an nft-type transaction.
  const nftTx = await prisma.transaction.findFirstOrThrow({
    where: { portfolioId, transactionHash: '0xnft414' },
    include: { nftDetail: true, type: true, direction: true },
  });
  expect(nftTx.type.name).toBe('nft');
  expect(nftTx.direction.name).toBe('buy');
  expect(nftTx.nftDetail!.tokenContractAddress).toBe('0xnftcontract414');
  expect(nftTx.nftDetail!.nftTokenId).toBe('7');

  // Two Nft holdings rows: the received-in-window NFT + the current-holdings NFT.
  const nfts = await prisma.nft.findMany({ where: { portfolioId }, orderBy: { contractAddress: 'asc' } });
  expect(nfts.map((n) => [n.contractAddress, n.tokenId])).toEqual([
    ['0xheldcontract414', '99'],
    ['0xnftcontract414', '7'],
  ]);
  // retrofit-51: the held holding's description is persisted; the in-window transfer (no
  // metadata) stores null — no crash either way.
  expect(nfts[0]!.description).toBe('A rare held collectible.');
  expect(nfts[1]!.description).toBeNull();
});

it('415: sync-more (Pro) imports the next page using the stored cursor and advances/clears it', async () => {
  const { cookie, userId } = await registerAndLogin();
  await setUserPro(userId); // retrofit-74 (§3): load-more is Pro-only.
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  const page2 = {
    transfers: [
      { type: 'native', direction: 'in', hash: '0xpage2tx', from: '0xolder', to: '0xwallet415', symbol: catalog.symbol, name: catalog.name, contractAddress: null, amount: 1, usdValue: 100, gasFee: null, timestamp: '2025-12-01T00:00:00.000Z', logoUrl: null, nftTokenId: null, collectionName: null },
    ],
    nextCursor: null as string | null, totalCount: null as number | null,
  };
  const page1 = { transfers: [] as unknown[], nextCursor: 'CURSOR2' as string | null, totalCount: null as number | null };
  // Initial sync (cursor undefined) → page1 (just sets the cursor); sync-more (cursor CURSOR2) → page2.
  fetchTransferPageMock.mockImplementation(async (_addr: string, _chain: unknown, opts: { cursor?: string | null }) =>
    opts.cursor === 'CURSOR2' ? page2 : page1,
  );
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 1, totalUsd: 1000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 1, decimals: 18, usdPrice: 1000, usdValue: 1000, isNative: true }],
    provider: 'moralis',
  });

  const created = await portPost('', { name: 'Paged Wallet', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  const portfolioId = (await created.json()).data.portfolio.id as number;
  // Initial sync stored the cursor.
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } })).syncCursor).toBe('CURSOR2');

  const before = await prisma.transaction.count({ where: { portfolioId, transactionHash: '0xpage2tx' } });
  expect(before).toBe(0);

  const res = await syncMoreGet(portfolioId, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()).data;
  expect(body).toEqual({ imported: 1, nextCursor: null });

  // The older transfer is now imported and the cursor cleared (no more pages).
  expect(await prisma.transaction.count({ where: { portfolioId, transactionHash: '0xpage2tx' } })).toBe(1);
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } })).syncCursor).toBeNull();
});

it('415b: sync-more is refused for a free user (load-more is Pro-only) — retrofit-74 §3', async () => {
  const { cookie } = await registerAndLogin(); // free sub by default
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // A connected portfolio with a stored cursor (so the only thing stopping load-more is the plan).
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 1, totalUsd: 1000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 1, decimals: 18, usdPrice: 1000, usdValue: 1000, isNative: true }],
    provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({ transfers: [], nextCursor: 'CURSOR2', totalCount: null });

  const created = await portPost('', { name: 'Free Wallet', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  const portfolioId = (await created.json()).data.portfolio.id as number;
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } })).syncCursor).toBe('CURSOR2');

  const res = await syncMoreGet(portfolioId, cookie);
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('PLAN_LIMIT_REACHED');
  // No-op: nothing imported, the cursor is untouched.
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } })).syncCursor).toBe('CURSOR2');
});

it('416: overview transactionCount = connected on-chain total + manual DB rows (retrofit-74 §1)', async () => {
  const { cookie, userId } = await registerAndLogin();
  // Upgrade to Pro so the user can hold both a connected and a manual portfolio.
  const pro = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  await prisma.subscription.update({ where: { userId }, data: { planId: pro.id } });
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // Connected: empty history page but a provider total of 137. retrofit-58: balance is set
  // from the summary (no opening lot), so the portfolio has ZERO DB transactions.
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 2, totalUsd: 2000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 2, decimals: 18, usdPrice: 1000, usdValue: 2000, isNative: true }],
    provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({ transfers: [], nextCursor: null, totalCount: 137 });

  const conn = await portPost('', { name: 'Conn 416', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(conn.status).toBe(201);
  const connId = (await conn.json()).data.portfolio.id as number;
  // The connected portfolio has 0 DB txns (no opening lot, empty page) — externalTxCount wins.
  expect(await prisma.transaction.count({ where: { portfolioId: connId } })).toBe(0);
  expect((await prisma.portfolio.findUniqueOrThrow({ where: { id: connId } })).externalTxCount).toBe(137);

  // Manual: seed 3 bare transaction rows → DB count = 3 (no externalTxCount).
  const manual = await portPost('', { name: 'Manual 416', type: 'manual' }, cookie);
  const manualId = (await manual.json()).data.portfolio.id as number;
  const nativeType = await prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } });
  const buyDir = await prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } });
  for (let i = 0; i < 3; i++) {
    await prisma.transaction.create({
      data: { portfolioId: manualId, typeId: nativeType.id, directionId: buyDir.id, timestamp: new Date('2026-03-01T00:00:00.000Z') },
    });
  }

  const res = await overviewGet(cookie);
  expect(res.status).toBe(200);
  const d = (await res.json()).data;
  // retrofit-74 (§1, reverts H10): the REAL total — 137 (connected on-chain) + 3 (manual DB rows)
  // = 140. The connected portfolio's own DB rows (0 here) are not added on top; externalTxCount IS
  // its total. One honest number; the separate onChainTransactionCount is gone.
  expect(d.totals.transactionCount).toBe(140);
  expect(d.totals.onChainTransactionCount).toBeUndefined();
});

// ---------------------------------------------------------------------------
// retrofit-50 — POST /portfolios/:id/resync (idempotent)
// ---------------------------------------------------------------------------

it('417: resync re-imports a deleted transfer, keeps balance on-chain, and is a no-op the 2nd time', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // On-chain balance 5; history = +3 in (0xaaa417), -1 out (0xbbb417) → net +2, residual lot 3.
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 5, totalUsd: 5000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 5, decimals: 18, usdPrice: 1000, usdValue: 5000, isNative: true }],
    provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({
    transfers: [
      { type: 'native', direction: 'in', hash: '0xaaa417', from: '0xsender', to: '0xwallet417', symbol: catalog.symbol, name: catalog.name, contractAddress: null, amount: 3, usdValue: 3000, gasFee: null, timestamp: '2026-01-10T00:00:00.000Z', logoUrl: null, nftTokenId: null, collectionName: null },
      { type: 'native', direction: 'out', hash: '0xbbb417', from: '0xwallet417', to: '0xrecv', symbol: catalog.symbol, name: catalog.name, contractAddress: null, amount: 1, usdValue: 1000, gasFee: null, timestamp: '2026-01-12T00:00:00.000Z', logoUrl: null, nftTokenId: null, collectionName: null },
    ],
    nextCursor: null, totalCount: null,
  });

  const created = await portPost('', { name: 'Resync Wallet', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(created.status).toBe(201);
  const portfolioId = (await created.json()).data.portfolio.id as number;

  // retrofit-58: initial sync imports 2 transfers as the feed (NO opening lot); balance is set
  // straight from the provider summary == on-chain 5.
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(2);
  const balanceOf = async () =>
    Number((await prisma.asset.findFirstOrThrow({ where: { portfolioId, tokenId: catalog.id } })).balance);
  expect(await balanceOf()).toBeCloseTo(5, 6);

  // Simulate a transfer that a missed webhook dropped: delete the 'in' transaction.
  await prisma.transaction.deleteMany({ where: { portfolioId, transactionHash: '0xaaa417' } });
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(1);

  // Resync re-imports exactly the missing transfer (the other is deduped on hash) and re-sets
  // the balance from the summary (reconciled = the 1 held token set).
  const r1 = await resyncPost(portfolioId, cookie);
  expect(r1.status).toBe(200);
  expect((await r1.json()).data).toEqual({ importedTransfers: 1, reconciled: 1 });
  expect(await prisma.transaction.count({ where: { portfolioId, transactionHash: '0xaaa417' } })).toBe(1);
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(2);
  expect(await balanceOf()).toBeCloseTo(5, 6);

  // retrofit-65: this free user just armed the 24h cooldown — clear it so this idempotency
  // check (not a rate-limit check) can run the second resync. The cooldown itself is covered
  // by the dedicated r65 tests below.
  await redis.del(`resync_cooldown:${portfolioId}`);

  // Running it again is a no-op: nothing imported, no duplicate rows, balance unchanged.
  const r2 = await resyncPost(portfolioId, cookie);
  expect((await r2.json()).data).toEqual({ importedTransfers: 0, reconciled: 1 });
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(2);
  expect(await balanceOf()).toBeCloseTo(5, 6);
});

it('418: resync on a manual portfolio → 400 NOT_CONNECTED', async () => {
  const { cookie } = await registerAndLogin();
  const created = await portPost('', { name: 'Manual Resync', type: 'manual' }, cookie);
  expect(created.status).toBe(201);
  const portfolioId = (await created.json()).data.portfolio.id as number;

  const res = await resyncPost(portfolioId, cookie);
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('NOT_CONNECTED');
});

it('419: resync another user\'s portfolio → 403 FORBIDDEN', async () => {
  const { cookie } = await registerAndLogin();
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const created = await portPost('', { name: 'Owned', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  const portfolioId = (await created.json()).data.portfolio.id as number;

  // A second user must not resync the first user's portfolio.
  await authPost('/register', { email: 'wallet.preview.b@neonfi.test', password: TEST_PASSWORD, fullName: 'Other' });
  const loginB = await authPost('/login', { email: 'wallet.preview.b@neonfi.test', password: TEST_PASSWORD });
  const cookieB = `session=${cookieValue(loginB, 'session')!}`;

  const res = await resyncPost(portfolioId, cookieB);
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// retrofit-65 — resync rate-limit (free: once/day, pro: 5-min cooldown) + retryAfter
// ---------------------------------------------------------------------------

it('r65-free: free user 2nd resync within 24h → 429 RESYNC_RATE_LIMITED (retryAfter ~86400, no 2nd sync)', async () => {
  const { cookie } = await registerAndLogin(); // free sub
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  // Provider mocks default to null/no-op → resync still succeeds (importedTransfers 0).
  const created = await portPost('', { name: 'Free Resync', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(created.status).toBe(201);
  const portfolioId = (await created.json()).data.portfolio.id as number;

  const first = await resyncPost(portfolioId, cookie);
  expect(first.status).toBe(200);

  // The cooldown is armed — capture the provider call count so we can prove no 2nd sync runs.
  const callsBefore = fetchWalletSummaryMock.mock.calls.length;
  const second = await resyncPost(portfolioId, cookie);
  expect(second.status).toBe(429);
  const body = await second.json();
  expect(body.error.code).toBe('RESYNC_RATE_LIMITED');
  expect(body.error.message).toMatch(/one resync per day/i);
  // retryAfter rides along under error.details (controller nests meta there).
  const retryAfter = body.error.details.retryAfter as number;
  expect(retryAfter).toBeGreaterThan(86000);
  expect(retryAfter).toBeLessThanOrEqual(86400);
  // No provider call happened on the rate-limited request — the resync never ran.
  expect(fetchWalletSummaryMock.mock.calls.length).toBe(callsBefore);
});

it('r65-pro: pro user 2nd resync same portfolio → 429 (retryAfter ~300, 5-min msg); a different portfolio still 200', async () => {
  const { cookie, userId } = await registerAndLogin();
  await setUserPro(userId); // 5-min cooldown applies
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });

  const p1res = await portPost('', { name: 'Pro Wallet One', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(p1res.status).toBe(201);
  const p1 = (await p1res.json()).data.portfolio.id as number;
  const p2res = await portPost('', { name: 'Pro Wallet Two', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(p2res.status).toBe(201);
  const p2 = (await p2res.json()).data.portfolio.id as number;

  expect((await resyncPost(p1, cookie)).status).toBe(200);

  // Immediate 2nd on the SAME portfolio → 429 with the 5-minute message + short retryAfter.
  const second = await resyncPost(p1, cookie);
  expect(second.status).toBe(429);
  const body = await second.json();
  expect(body.error.code).toBe('RESYNC_RATE_LIMITED');
  expect(body.error.message).toMatch(/every 5 minutes/i);
  const retryAfter = body.error.details.retryAfter as number;
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(300);

  // A DIFFERENT portfolio is independent (per-portfolio key) → still 200.
  expect((await resyncPost(p2, cookie)).status).toBe(200);
});
