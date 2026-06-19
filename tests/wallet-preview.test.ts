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
const { previewWalletMock, fetchWalletSummaryMock, fetchTransferPageMock, fetchNftHoldingsMock } =
  vi.hoisted(() => ({
    previewWalletMock: vi.fn(),
    fetchWalletSummaryMock: vi.fn(),
    fetchTransferPageMock: vi.fn(),
    fetchNftHoldingsMock: vi.fn(),
  }));
vi.mock('../src/modules/wallet-data/index.js', () => ({
  previewWallet: previewWalletMock,
  fetchWalletSummary: fetchWalletSummaryMock,
  fetchTransferPage: fetchTransferPageMock,
  fetchNftHoldings: fetchNftHoldingsMock,
  fetchTransactionCount: vi.fn().mockResolvedValue(null),
  fetchValueHistory: vi.fn().mockResolvedValue(null),
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
  previewWalletMock.mockReset();
  fetchWalletSummaryMock.mockReset();
  fetchTransferPageMock.mockReset();
  fetchNftHoldingsMock.mockReset();
  fetchWalletSummaryMock.mockResolvedValue(null); // default: connected create seeds nothing
  fetchTransferPageMock.mockResolvedValue(null); // default: no transfer history
  fetchNftHoldingsMock.mockResolvedValue(null); // default: no current nft holdings
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

// ---------------------------------------------------------------------------
// retrofit-49 — real transfer-history import + NFT + sync-more + overview count
// ---------------------------------------------------------------------------

it('413: connected create imports REAL transfers + reconciles a residual opening lot to the on-chain balance', async () => {
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

  // Two imported transfers + one reconciling opening lot = 3 transactions.
  const txns = await prisma.transaction.findMany({
    where: { portfolioId },
    include: { nativeDetail: true, direction: true, type: true },
    orderBy: { timestamp: 'asc' },
  });
  expect(txns).toHaveLength(3);

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

  // The opening lot is the third tx (no hash) dated BEFORE the earliest import.
  const opening = txns.find((t) => t.transactionHash === null)!;
  expect(opening.direction.name).toBe('buy');
  expect(opening.timestamp.getTime()).toBeLessThan(new Date('2026-01-10T00:00:00.000Z').getTime());

  // Reconciled balance == provider current balance (residual lot makes it exact).
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

it('415: sync-more imports the next page using the stored cursor and advances/clears it', async () => {
  const { cookie } = await registerAndLogin();
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

it('416: overview transactionCount uses externalTxCount for connected, DB count for manual', async () => {
  const { cookie, userId } = await registerAndLogin();
  // Upgrade to Pro so the user can hold both a connected and a manual portfolio.
  const pro = await prisma.plan.findUniqueOrThrow({ where: { name: 'pro' } });
  await prisma.subscription.update({ where: { userId }, data: { planId: pro.id } });
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const catalog = await prisma.token.findFirstOrThrow({ orderBy: { id: 'asc' } });

  // Connected: empty history page but a provider total of 137; sync still seeds ONE opening lot.
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: catalog.symbol, nativeBalance: 2, totalUsd: 2000, tokenCount: 1,
    tokens: [{ symbol: catalog.symbol, name: catalog.name, contractAddress: null, balance: 2, decimals: 18, usdPrice: 1000, usdValue: 2000, isNative: true }],
    provider: 'moralis',
  });
  fetchTransferPageMock.mockResolvedValue({ transfers: [], nextCursor: null, totalCount: 137 });

  const conn = await portPost('', { name: 'Conn 416', type: 'connected', walletAddress: VALID_EVM, chainId: eth.id }, cookie);
  expect(conn.status).toBe(201);
  const connId = (await conn.json()).data.portfolio.id as number;
  // The connected portfolio actually has 1 DB tx (the opening lot) — but externalTxCount wins.
  expect(await prisma.transaction.count({ where: { portfolioId: connId } })).toBe(1);
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
  // 137 (connected external total) + 3 (manual DB rows) = 140 — NOT 1 + 3.
  expect(d.totals.transactionCount).toBe(140);
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

  // Initial sync: 2 transfers + 1 reconciling opening lot = 3 txns; balance == on-chain 5.
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(3);
  const balanceOf = async () =>
    Number((await prisma.asset.findFirstOrThrow({ where: { portfolioId, tokenId: catalog.id } })).balance);
  expect(await balanceOf()).toBeCloseTo(5, 6);

  // Simulate a transfer that a missed webhook dropped: delete the 'in' transaction.
  await prisma.transaction.deleteMany({ where: { portfolioId, transactionHash: '0xaaa417' } });
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(2);

  // Resync re-imports exactly the missing transfer (the other is deduped on hash).
  const r1 = await resyncPost(portfolioId, cookie);
  expect(r1.status).toBe(200);
  expect((await r1.json()).data).toEqual({ importedTransfers: 1, reconciled: 1 });
  expect(await prisma.transaction.count({ where: { portfolioId, transactionHash: '0xaaa417' } })).toBe(1);
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(3);
  expect(await balanceOf()).toBeCloseTo(5, 6);

  // Running it again is a no-op: nothing imported, no duplicate rows, balance unchanged.
  const r2 = await resyncPost(portfolioId, cookie);
  expect((await r2.json()).data).toEqual({ importedTransfers: 0, reconciled: 1 });
  expect(await prisma.transaction.count({ where: { portfolioId } })).toBe(3);
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
