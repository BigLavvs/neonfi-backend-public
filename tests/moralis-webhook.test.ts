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
  await prisma.user.deleteMany({ where: { email: MORALIS_TEST_EMAIL } });
  await clearMoralisRedisKeys();

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

it('274: native transfer IN (to=walletAddr, known portfolio, known token) → 200, Asset.balance increases, direction=buy', async () => {
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

  // Verify Transaction was inserted with direction='buy'
  const tx = await prisma.transaction.findFirst({
    where: { portfolioId, transactionHash: '0xhash274' },
    include: { direction: true },
  });
  expect(tx).not.toBeNull();
  expect(tx!.direction.name).toBe('buy');

  // Verify Asset.balance = 2 ETH
  const asset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: ethTokenId } },
  });
  expect(asset).not.toBeNull();
  expect(Number(asset!.balance.toString())).toBeCloseTo(2, 8);
});

it('275: native transfer OUT (from=walletAddr) → 200, direction=sell, balance decreases', async () => {
  // Seed initial ETH balance via a prior buy webhook — recalcAssetBalance derives
  // balance from transactions, not from the asset.balance column directly.
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

  // Balance was 5, sold 1 → 4
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

it('277: ERC-20 transfer for known token, Asset does not exist yet → Asset auto-created, balance recalcd', async () => {
  // Confirm no USDC asset exists
  const existingAsset = await prisma.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId: usdcTokenId } },
  });
  expect(existingAsset).toBeNull();

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
// NFT deferral (test 278)
// ---------------------------------------------------------------------------

it('278: NFT transfer event → 200 with deferred count; no Transaction/Asset writes', async () => {
  const nftsBefore = await prisma.nft.count({ where: { portfolioId } });

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
        },
      ],
    },
    'stream-278',
  );
  const res = await postWebhook(payload, sign(payload));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.deferred).toBe(1);
  expect(json.data.processed).toBe(0);

  // No Nft table writes
  const nftsAfter = await prisma.nft.count({ where: { portfolioId } });
  expect(nftsAfter).toBe(nftsBefore);

  // No Transaction writes either
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
  expect(json.data.deferred).toBe(0);

  const txCount = await prisma.transaction.count({ where: { portfolioId } });
  expect(txCount).toBe(0);
});

it('280: multiple transfers in single payload (native + erc20) → 200, counts reflect all, idempotency key set once', async () => {
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
