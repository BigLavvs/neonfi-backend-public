// Neonfi backend — Moralis webhook integration tests (Stage 11).
//
// Strategy: real DB + real Redis. Moralis-signed payloads constructed per-test
// using keccak256(JSON.stringify(payload) + MORALIS_WEBHOOK_SECRET).
// Tests numbered 269–280 (continuing from Stage 10B's 268).

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { keccak256 } from 'js-sha3';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { truncateAllUserData } from './helpers.js';

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

// retrofit-59 §1/§2: a connected portfolio's balance no longer comes from recalc'ing the
// webhook's transactions — recalc skips connected, and the webhook instead REFRESHES balances
// from the provider summary after the feed write. Mock fetchWalletSummary so the balance the
// webhook lands is deterministic; keep the rest of wallet-data real (partial mock).
const { fetchWalletSummaryMock } = vi.hoisted(() => ({ fetchWalletSummaryMock: vi.fn() }));
vi.mock('../src/modules/wallet-data/index.js', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  fetchWalletSummary: fetchWalletSummaryMock,
}));

// Build a provider WalletSummary from a simple token list (contractAddress null → resolved by
// symbol against the seeded catalog, no contract backfill).
function summaryOf(tokens: Array<{ symbol: string; balance: number; isNative?: boolean }>): unknown {
  return {
    nativeSymbol: 'ETH',
    nativeBalance: tokens.find((t) => t.isNative)?.balance ?? 0,
    totalUsd: null,
    tokenCount: tokens.length,
    tokens: tokens.map((t) => ({
      symbol: t.symbol, name: t.symbol, contractAddress: null, balance: t.balance,
      decimals: 18, usdPrice: 1, usdValue: t.balance, isNative: !!t.isNative,
    })),
    provider: 'moralis',
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_BASE = '/api/v1/webhooks/moralis';
const MORALIS_TEST_EMAIL = 'moralis.webhook@neonfi.test';
const WALLET_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const UNKNOWN_WALLET = '0x9999999999999999999999999999999999999999';
const ETH_MORALIS_ID = '0x1';
const UNKNOWN_CHAIN_ID = '0xdead';

// MORALIS_WEBHOOK_SECRET from config (loaded from .env)
const SECRET = process.env.MORALIS_WEBHOOK_SECRET!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(body: object): string {
  return keccak256(JSON.stringify(body) + SECRET);
}

function makePayload(
  overrides: Record<string, unknown> = {},
  streamId = 'stream-test',
  tag = 'test',
): object {
  return {
    txs: [],
    erc20Transfers: [],
    nftTransfers: [],
    chainId: ETH_MORALIS_ID,
    streamId,
    tag,
    confirmed: true,
    block: { timestamp: '1704067200', number: '19000000', hash: '0xblockhash' },
    ...overrides,
  };
}

async function postWebhook(
  body: object,
  signature: string | null = sign(body),
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (signature !== null) headers['x-signature'] = signature;
  return app.request(WEBHOOK_BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function clearMoralisRedisKeys(): Promise<void> {
  const keys = await redis.keys('moralis_event:*');
  if (keys.length > 0) await redis.del(keys);
}

// ---------------------------------------------------------------------------
// Seed state
// ---------------------------------------------------------------------------

let ethChainId: number;
let ethTokenId: number;
let usdcTokenId: number;
let portfolioId: number;

beforeAll(async () => {
  const ethChain = await prisma.chain.findUniqueOrThrow({ where: { moralisId: ETH_MORALIS_ID } });
  ethChainId = ethChain.id;
  const ethToken = await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } });
  ethTokenId = ethToken.id;
  const usdcToken = await prisma.token.findUniqueOrThrow({ where: { symbol: 'USDC' } });
  usdcTokenId = usdcToken.id;
});

beforeEach(async () => {
  // Cleanup DB state from prior tests
  await truncateAllUserData();
  await clearMoralisRedisKeys();
  // Default: provider reports no balances → the post-webhook refresh zeros connected assets.
  // Balance-asserting tests override this with summaryOf(...).
  fetchWalletSummaryMock.mockReset();
  fetchWalletSummaryMock.mockResolvedValue(null);

  // Seed a connected portfolio on Ethereum for tests that need it
  const authProvider = await prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } });
  const onboardingStatus = await prisma.onboardingStatus.findUniqueOrThrow({
    where: { name: 'complete' },
  });
  const user = await prisma.user.create({
    data: {
      email: MORALIS_TEST_EMAIL,
      passwordHash: 'irrelevant',
      fullName: 'Moralis Test User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboardingStatus.id,
    },
  });

  const connectedType = await prisma.portfolioType.findUniqueOrThrow({
    where: { name: 'connected' },
  });
  const portfolio = await prisma.portfolio.create({
    data: {
      userId: user.id,
      name: 'Moralis Connected Portfolio',
      typeId: connectedType.id,
      walletAddress: WALLET_ADDRESS,
      chainId: ethChainId,
    },
  });
  portfolioId = portfolio.id;
});

// ---------------------------------------------------------------------------
// Signature & idempotency (tests 269–272)
// ---------------------------------------------------------------------------

it('269: valid signature + empty payload → 200 { received: true }', async () => {
  const payload = makePayload({}, 'stream-269');
  const res = await postWebhook(payload);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.received).toBe(true);
  expect(json.data.duplicate).toBeUndefined();
});

it('270: invalid signature → 401 INVALID_SIGNATURE, no DB writes', async () => {
  const payload = makePayload({}, 'stream-270');
  const res = await postWebhook(payload, 'deadbeef'.repeat(8));
  expect(res.status).toBe(401);
  const json = await res.json();
  expect(json.error.code).toBe('INVALID_SIGNATURE');
  // Confirm no Redis key was set
  const key = await redis.get(`moralis_event:stream-270_${ETH_MORALIS_ID}_test`);
  expect(key).toBeNull();
});

it('271: missing x-signature header → 401 INVALID_SIGNATURE', async () => {
  const payload = makePayload({}, 'stream-271');
  const res = await postWebhook(payload, null);
  expect(res.status).toBe(401);
  const json = await res.json();
  expect(json.error.code).toBe('INVALID_SIGNATURE');
});

it('272: duplicate event ID → first call 200; second call { duplicate: true }; one Transaction row', async () => {
  const payload = makePayload(
    {
      txs: [
        {
          hash: '0xduphash272',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          value: '1000000000000000000',
        },
      ],
    },
    'stream-272',
  );
  const sig = sign(payload);

  const res1 = await postWebhook(payload, sig);
  expect(res1.status).toBe(200);
  const json1 = await res1.json();
  expect(json1.data.duplicate).toBeUndefined();

  const res2 = await postWebhook(payload, sig);
  expect(res2.status).toBe(200);
  const json2 = await res2.json();
  expect(json2.data.duplicate).toBe(true);

  // Only one Transaction row should exist for this hash
  const count = await prisma.transaction.count({
    where: { transactionHash: '0xduphash272', portfolioId },
  });
  expect(count).toBe(1);
});

// ---------------------------------------------------------------------------
// Transfer handling (tests 273–277)
// ---------------------------------------------------------------------------

it('273: native transfer IN for unknown chain → 200 with skipped count; no DB writes', async () => {
  const payload = makePayload(
    {
      chainId: UNKNOWN_CHAIN_ID,
      txs: [{ hash: '0xhash273', from: OTHER_ADDRESS, to: WALLET_ADDRESS, value: '1000000000000000000' }],
    },
    'stream-273',
    'test',
  );
  // Re-sign with the actual body we'll send (chainId is overridden)
  const sig = sign(payload);
  const res = await postWebhook(payload, sig);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.received).toBe(true);
  expect(json.data.skipped).toBeGreaterThan(0);
  // No transaction created
  const count = await prisma.transaction.count({ where: { portfolioId } });
  expect(count).toBe(0);
});

it('274: native transfer IN → 200, tx in feed (direction=buy), balance refreshed from provider (retrofit-59)', async () => {
  // retrofit-59: balance now comes from the provider summary refresh, not recalc — provider says 2 ETH.
  fetchWalletSummaryMock.mockResolvedValue(summaryOf([{ symbol: 'ETH', balance: 2, isNative: true }]));
  const payload = makePayload(
    {
      txs: [{ hash: '0xhash274', from: OTHER_ADDRESS, to: WALLET_ADDRESS, value: '2000000000000000000' }],
    },
    'stream-274',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);
  expect(json.data.skipped).toBe(0);

  // Verify Transaction was inserted with direction='buy' (the activity feed is unchanged).
  const tx = await prisma.transaction.findFirst({
    where: { portfolioId, transactionHash: '0xhash274' },
    include: { direction: true },
  });
  expect(tx).not.toBeNull();
  expect(tx!.direction.name).toBe('buy');

  // Asset.balance reflects the PROVIDER summary (2 ETH), refreshed after the feed write.
  const asset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: ethTokenId } },
  });
  expect(asset).not.toBeNull();
  expect(Number(asset!.balance.toString())).toBeCloseTo(2, 8);
});

it('275: native transfer OUT → 200, direction=sell, balance reflects the provider (retrofit-59)', async () => {
  // retrofit-59: after the OUT transfer the wallet holds 4 ETH on-chain — the provider summary
  // (not a recalc of the windowed txns) is the balance source.
  fetchWalletSummaryMock.mockResolvedValue(summaryOf([{ symbol: 'ETH', balance: 4, isNative: true }]));
  // A prior IN transfer just to put a row in the feed (its recalc is a no-op for connected now).
  const setupPayload = makePayload(
    {
      txs: [{ hash: '0xhash275-setup', from: OTHER_ADDRESS, to: WALLET_ADDRESS, value: '5000000000000000000' }],
    },
    'stream-275-setup',
  );
  await postWebhook(setupPayload, sign(setupPayload));

  const payload = makePayload(
    {
      txs: [{ hash: '0xhash275', from: WALLET_ADDRESS, to: OTHER_ADDRESS, value: '1000000000000000000' }],
    },
    'stream-275',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);

  const tx = await prisma.transaction.findFirst({
    where: { portfolioId, transactionHash: '0xhash275' },
    include: { direction: true },
  });
  expect(tx!.direction.name).toBe('sell');

  // Balance = the provider's current on-chain balance (4 ETH).
  const asset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: ethTokenId } },
  });
  expect(Number(asset!.balance.toString())).toBeCloseTo(4, 8);
});

it('276: ERC-20 transfer for unknown token symbol → 200 with skipped count; no DB writes', async () => {
  const payload = makePayload(
    {
      erc20Transfers: [
        {
          transactionHash: '0xhash276',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          value: '1000000',
          tokenName: 'Fake Token',
          tokenSymbol: 'FAKE_XYZ_NOT_REAL',
          tokenDecimals: '6',
          contract: '0xfakecontract',
        },
      ],
    },
    'stream-276',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.skipped).toBe(1);
  // No transaction row
  const count = await prisma.transaction.count({ where: { portfolioId } });
  expect(count).toBe(0);
});

it('277: ERC-20 transfer for known token, Asset does not exist yet → Asset created, balance from provider', async () => {
  // Confirm no USDC asset exists
  const existingAsset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: usdcTokenId } },
  });
  expect(existingAsset).toBeNull();

  // retrofit-59: provider reports 5 USDC → that's the balance the refresh lands.
  fetchWalletSummaryMock.mockResolvedValue(summaryOf([{ symbol: 'USDC', balance: 5 }]));

  const payload = makePayload(
    {
      erc20Transfers: [
        {
          transactionHash: '0xhash277',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          value: '5000000', // 5 USDC (6 decimals)
          tokenName: 'USD Coin',
          tokenSymbol: 'USDC',
          tokenDecimals: '6',
          contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        },
      ],
    },
    'stream-277',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);

  // Asset auto-created
  const asset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: usdcTokenId } },
  });
  expect(asset).not.toBeNull();
  // Balance should be 5 USDC
  expect(Number(asset!.balance.toString())).toBeCloseTo(5, 4);

  // Transaction inserted
  const tx = await prisma.transaction.findFirst({
    where: { portfolioId, transactionHash: '0xhash277' },
    include: { direction: true },
  });
  expect(tx).not.toBeNull();
  expect(tx!.direction.name).toBe('buy');
});

// ---------------------------------------------------------------------------
// NFT upsert (test 278)
// ---------------------------------------------------------------------------

it('278: NFT transfer IN → 200 processed=1; Nft row upserted; no Transaction/Asset writes', async () => {
  const payload = makePayload(
    {
      nftTransfers: [
        {
          transactionHash: '0xhash278',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          tokenAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '1234',
          amount: '1',
          tokenName: 'Bored Ape #1234',
          collectionName: 'BoredApeYachtClub',
          tokenContractType: 'ERC721',
          image: 'https://example.com/ape.png',
        },
      ],
    },
    'stream-278',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);

  // Nft row upserted
  const nft = await prisma.nft.findFirst({
    where: { portfolioId, tokenId: '1234', contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' },
  });
  expect(nft).not.toBeNull();
  expect(nft!.name).toBe('Bored Ape #1234');

  // No Transaction writes
  const txCount = await prisma.transaction.count({ where: { portfolioId } });
  expect(txCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Edge cases (tests 279–280)
// ---------------------------------------------------------------------------

it('279: wallet address does not match any portfolio → 200 with all zero counts; no DB writes', async () => {
  const payload = makePayload(
    {
      txs: [
        {
          hash: '0xhash279',
          from: UNKNOWN_WALLET,
          to: UNKNOWN_WALLET,
          value: '1000000000000000000',
        },
      ],
    },
    'stream-279',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(0);
  expect(json.data.skipped).toBe(0);

  const txCount = await prisma.transaction.count({ where: { portfolioId } });
  expect(txCount).toBe(0);
});

it('280: multiple transfers in single payload (native + erc20) → 200, counts reflect all, idempotency key set once', async () => {
  // retrofit-59: balances come from the provider summary refresh (ETH 1, USDC 3).
  fetchWalletSummaryMock.mockResolvedValue(summaryOf([
    { symbol: 'ETH', balance: 1, isNative: true },
    { symbol: 'USDC', balance: 3 },
  ]));
  const payload = makePayload(
    {
      txs: [
        { hash: '0xhash280a', from: OTHER_ADDRESS, to: WALLET_ADDRESS, value: '1000000000000000000' },
      ],
      erc20Transfers: [
        {
          transactionHash: '0xhash280b',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          value: '3000000', // 3 USDC
          tokenName: 'USD Coin',
          tokenSymbol: 'USDC',
          tokenDecimals: '6',
          contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        },
      ],
    },
    'stream-280',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(2); // 1 native + 1 erc20
  expect(json.data.skipped).toBe(0);

  // Both transactions inserted
  const txCount = await prisma.transaction.count({ where: { portfolioId } });
  expect(txCount).toBe(2);

  // ETH asset created
  const ethAsset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: ethTokenId } },
  });
  expect(Number(ethAsset!.balance.toString())).toBeCloseTo(1, 8);

  // USDC asset created
  const usdcAsset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: usdcTokenId } },
  });
  expect(Number(usdcAsset!.balance.toString())).toBeCloseTo(3, 4);

  // Idempotency key set exactly once
  const key = await redis.get(`moralis_event:stream-280_${ETH_MORALIS_ID}_test`);
  expect(key).toBe('1');
});

// ---------------------------------------------------------------------------
// NFT OUT, null marketplace fields, idempotency (tests 291–293)
// ---------------------------------------------------------------------------

it('291: NFT transfer OUT → Nft row deleted', async () => {
  // First upsert an NFT row via IN transfer
  const inPayload = makePayload(
    {
      nftTransfers: [
        {
          transactionHash: '0xhash291-setup',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          tokenAddress: '0xdeadbeef00000000000000000000000000000001',
          tokenId: '9001',
          amount: '1',
          tokenName: 'Test NFT #9001',
          collectionName: 'TestCollection',
          tokenContractType: 'ERC721',
        },
      ],
    },
    'stream-291-setup',
  );
  await postWebhook(inPayload, sign(inPayload));

  const countBefore = await prisma.nft.count({
    where: { portfolioId, tokenId: '9001', contractAddress: '0xdeadbeef00000000000000000000000000000001' },
  });
  expect(countBefore).toBe(1);

  // Now send OUT transfer
  const outPayload = makePayload(
    {
      nftTransfers: [
        {
          transactionHash: '0xhash291-out',
          from: WALLET_ADDRESS,
          to: OTHER_ADDRESS,
          tokenAddress: '0xdeadbeef00000000000000000000000000000001',
          tokenId: '9001',
          amount: '1',
        },
      ],
    },
    'stream-291-out',
  );
  const res = await postWebhook(outPayload, sign(outPayload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);

  const countAfter = await prisma.nft.count({
    where: { portfolioId, tokenId: '9001', contractAddress: '0xdeadbeef00000000000000000000000000000001' },
  });
  expect(countAfter).toBe(0);
});

it('292: NFT transfer IN with no marketplace fields → Nft row has null marketplace columns', async () => {
  const payload = makePayload(
    {
      nftTransfers: [
        {
          transactionHash: '0xhash292',
          from: OTHER_ADDRESS,
          to: WALLET_ADDRESS,
          tokenAddress: '0xdeadbeef00000000000000000000000000000002',
          tokenId: '7777',
          amount: '1',
          // No tokenName, collectionName, tokenContractType, floorPrice, traits, etc.
        },
      ],
    },
    'stream-292',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.processed).toBe(1);

  const nft = await prisma.nft.findFirst({
    where: { portfolioId, tokenId: '7777', contractAddress: '0xdeadbeef00000000000000000000000000000002' },
  });
  expect(nft).not.toBeNull();
  expect(nft!.name).toBeNull();
  expect(nft!.collectionName).toBeNull();
  expect(nft!.tokenStandard).toBeNull();
  expect(nft!.floorPrice).toBeNull();
  expect(nft!.traits).toBeNull();
});

it('293: NFT transfer IN sent twice (idempotency) → exactly one Nft row', async () => {
  const nftTransfer = {
    transactionHash: '0xhash293',
    from: OTHER_ADDRESS,
    to: WALLET_ADDRESS,
    tokenAddress: '0xdeadbeef00000000000000000000000000000003',
    tokenId: '4242',
    amount: '1',
    tokenName: 'Dup NFT #4242',
    collectionName: 'DupCollection',
    tokenContractType: 'ERC721',
  };

  const payload1 = makePayload({ nftTransfers: [nftTransfer] }, 'stream-293-first');
  const payload2 = makePayload({ nftTransfers: [nftTransfer] }, 'stream-293-second');

  const res1 = await postWebhook(payload1, sign(payload1));
  expect(res1.status).toBe(200);

  const res2 = await postWebhook(payload2, sign(payload2));
  expect(res2.status).toBe(200);

  const count = await prisma.nft.count({
    where: { portfolioId, tokenId: '4242', contractAddress: '0xdeadbeef00000000000000000000000000000003' },
  });
  expect(count).toBe(1);
});
