// Neonfi backend — Moralis retry-safety unit test (retrofit-17 §3).
//
// Pure unit test (no DB/Redis/network): redis, prisma, the transactions service, and
// the signature verifier are all mocked so we can drive handleMoralisWebhook through
// each outcome deterministically. The contract under test:
//
//   • TRANSIENT/UNEXPECTED per-transfer error → 500 AND the moralis_event dedupe key
//     is NEVER set, so Moralis retries the whole payload.
//   • GENUINE BUSINESS skip (unknown token/chain) → 200 AND the dedupe key IS set
//     (retrying would never succeed, so we ack).
//   • DUPLICATE hash → idempotent success (200, counted processed, dedupe set).

import { it, expect, describe, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';

const WALLET = '0xabcdef1234567890abcdef1234567890abcdef12';
const OTHER = '0x1111111111111111111111111111111111111111';

const mocks = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  createTransactionFromWebhook: vi.fn(),
  chainFindUnique: vi.fn(),
  portfolioFindFirst: vi.fn(),
  tokenFindFirst: vi.fn(),
}));

vi.mock('../src/lib/moralis-signature.js', () => ({
  verifyMoralisSignature: () => true,
}));

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => mocks.redisStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      mocks.redisStore.set(k, v);
      return 'OK';
    }),
    keys: vi.fn(async () => []),
    del: vi.fn(async () => 1),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    chain: { findUnique: mocks.chainFindUnique },
    portfolio: { findFirst: mocks.portfolioFindFirst },
    token: { findFirst: mocks.tokenFindFirst },
    nft: { upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock('../src/modules/transactions/transactions.service.js', () => ({
  createTransactionFromWebhook: mocks.createTransactionFromWebhook,
}));

import { handleMoralisWebhook } from '../src/modules/webhooks/moralis-handlers.js';
import { redis } from '../src/lib/redis.js';

// Minimal Hono Context stand-in — handleMoralisWebhook only uses req.text(),
// req.header('x-signature'), and c.json(body, status).
function makeCtx(payload: object): Context {
  const rawBody = JSON.stringify(payload);
  return {
    req: {
      text: async () => rawBody,
      header: (name: string) => (name === 'x-signature' ? 'mock-sig' : undefined),
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as Context;
}

function dedupeKey(streamId: string, chainId: string, tag: string): string {
  return `moralis_event:${streamId}_${chainId}_${tag}`;
}

beforeEach(() => {
  mocks.redisStore.clear();
  vi.mocked(redis.get).mockClear();
  vi.mocked(redis.set).mockClear();

  mocks.chainFindUnique.mockReset().mockResolvedValue({ id: 1, slug: 'eth' });
  // Only the tracked WALLET resolves to a connected portfolio; everything else is null.
  mocks.portfolioFindFirst.mockReset().mockImplementation(async (args: any) => {
    return args?.where?.walletAddress === WALLET
      ? { id: 10, walletAddress: WALLET, chainId: 1, type: { name: 'connected' }, chain: {} }
      : null;
  });
  mocks.tokenFindFirst.mockReset().mockResolvedValue({ id: 5, symbol: 'USDC' });
  mocks.createTransactionFromWebhook.mockReset().mockResolvedValue(123);
});

const nativePayload = (extra: object = {}) => ({
  txs: [{ hash: '0xnative1', from: OTHER, to: WALLET, value: '1000000000000000000' }],
  erc20Transfers: [],
  nftTransfers: [],
  chainId: '0x1',
  streamId: 'stream-retry',
  tag: 'test',
  ...extra,
});

describe('Moralis webhook retry safety (retrofit-17 §3)', () => {
  it('TRANSIENT native error → 500 and NO dedupe key set (Moralis retries)', async () => {
    const transient = Object.assign(new Error('server closed the connection'), { code: 'P1017' });
    mocks.createTransactionFromWebhook.mockRejectedValueOnce(transient);

    const res = await handleMoralisWebhook(makeCtx(nativePayload()));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('WEBHOOK_HANDLER_ERROR');

    // The transfer WAS attempted...
    expect(mocks.createTransactionFromWebhook).toHaveBeenCalledTimes(1);
    // ...but the dedupe key must NOT be set, so Moralis can retry.
    expect(redis.set).not.toHaveBeenCalled();
    expect(mocks.redisStore.has(dedupeKey('stream-retry', '0x1', 'test'))).toBe(false);
  });

  it('TRANSIENT erc20 error (generic throw) → 500 and NO dedupe key set', async () => {
    const payload = {
      txs: [],
      erc20Transfers: [
        {
          transactionHash: '0xerc20a',
          from: OTHER,
          to: WALLET,
          value: '1000000',
          tokenSymbol: 'USDC',
          tokenDecimals: '6',
          contract: '0xc',
        },
      ],
      nftTransfers: [],
      chainId: '0x1',
      streamId: 'stream-erc20',
      tag: 'test',
    };
    mocks.createTransactionFromWebhook.mockRejectedValueOnce(new Error('unexpected boom'));

    const res = await handleMoralisWebhook(makeCtx(payload));

    expect(res.status).toBe(500);
    expect(redis.set).not.toHaveBeenCalled();
    expect(mocks.redisStore.has(dedupeKey('stream-erc20', '0x1', 'test'))).toBe(false);
  });

  it('GENUINE business skip (unknown token) → 200, skipped, dedupe key IS set', async () => {
    mocks.tokenFindFirst.mockResolvedValueOnce(null); // token not in catalog
    const payload = {
      txs: [],
      erc20Transfers: [
        {
          transactionHash: '0xunknown',
          from: OTHER,
          to: WALLET,
          value: '1000000',
          tokenSymbol: 'NOTREAL',
          tokenDecimals: '6',
          contract: '0xc',
        },
      ],
      nftTransfers: [],
      chainId: '0x1',
      streamId: 'stream-biz',
      tag: 'test',
    };

    const res = await handleMoralisWebhook(makeCtx(payload));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.skipped).toBe(1);
    expect(json.data.processed).toBe(0);
    // A deterministic business skip is acked + deduped.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(mocks.redisStore.get(dedupeKey('stream-biz', '0x1', 'test'))).toBe('1');
    // Never even attempted to write a transaction.
    expect(mocks.createTransactionFromWebhook).not.toHaveBeenCalled();
  });

  it('DUPLICATE hash → idempotent success (200, processed, dedupe set, no retry)', async () => {
    const dup = Object.assign(new Error('dup'), { code: 'TRANSACTION_HASH_DUPLICATE' });
    mocks.createTransactionFromWebhook.mockRejectedValueOnce(dup);

    const res = await handleMoralisWebhook(makeCtx(nativePayload({ streamId: 'stream-dup' })));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.processed).toBe(1); // counted as processed — already ingested
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(mocks.redisStore.get(dedupeKey('stream-dup', '0x1', 'test'))).toBe('1');
  });

  it('happy path native IN → 200 processed=1 and dedupe key set', async () => {
    const res = await handleMoralisWebhook(makeCtx(nativePayload({ streamId: 'stream-ok' })));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.processed).toBe(1);
    expect(json.data.skipped).toBe(0);
    expect(mocks.redisStore.get(dedupeKey('stream-ok', '0x1', 'test'))).toBe('1');
  });
});
