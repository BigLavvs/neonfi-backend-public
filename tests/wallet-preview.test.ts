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
