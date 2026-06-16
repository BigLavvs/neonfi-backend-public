// Neonfi backend — Moralis webhook handlers (Stage 11).
//
// Handles blockchain event ingress from Moralis Streams.
// Signature algorithm: Keccak-256 (Ethereum) — NOT SHA3-256 (NIST) — different algorithms.
// Raw body from c.req.text() is exactly what Moralis signed. No JSON.parse+JSON.stringify
// before verification — re-serialization changes whitespace and breaks the signature.
//
// Direction mapping for connected portfolios (contrast with Stage 9A manual-portfolio rule):
//   IN  (to   === portfolio.walletAddress) → direction='buy'  (received  → balance += amount)
//   OUT (from === portfolio.walletAddress) → direction='sell' (sent      → balance -= amount)
// Stage 9A's manual-portfolio simplification treats transfer='no-op'. That does NOT apply
// here: connected portfolios reflect on-chain truth, so every transfer affects balance.
//
// Token catalog is owned by Stage 9B's CMC sync. We never auto-create Token rows from
// webhook events (spam/scam tokens). Unknown tokens are logged and skipped.
//
// NFT events (nftTransfers[]) are deferred to Stage 12. They are logged and acked 200 so
// Moralis stops retrying; Stage 12 will implement the Nft table writes.

import type { Context } from 'hono';
import jsSha3 from 'js-sha3';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { ok, err } from '../../lib/envelope.js';
import { verifyMoralisSignature } from '../../lib/moralis-signature.js';
import { createTransactionFromWebhook } from '../transactions/transactions.service.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';

// js-sha3 is CommonJS with dynamically-built exports — default-import then destructure
// (a named import throws at the real tsx/node boot; vitest's loader masks it). See the
// matching note in lib/moralis-signature.ts. (boot fix)
const { keccak256 } = jsSha3;

const REDIS_TTL_30_DAYS = 2592000;

// ---------------------------------------------------------------------------
// Moralis Streams payload types
// ---------------------------------------------------------------------------

interface MoralisBlock {
  timestamp?: string;
  number?: string;
  hash?: string;
}

interface MoralisNativeTx {
  hash?: string;
  from?: string;
  to?: string;
  fromAddress?: string;
  toAddress?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
}

interface MoralisErc20Transfer {
  transactionHash?: string;
  from?: string;
  to?: string;
  value?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: string;
  contract?: string;
}

interface MoralisNftTransfer {
  transactionHash?: string;
  from?: string;
  to?: string;
  tokenAddress?: string;
  tokenId?: string;
  amount?: string;
  // Marketplace fields — present when Moralis includes them, absent otherwise
  tokenName?: string;
  collectionName?: string;
  logoUrl?: string;
  tokenStandard?: string;
  floorPrice?: string;
  floorPriceUsd?: string;
  lastSale?: string;
  lastSaleNote?: string;
  rarity?: string;
  traits?: unknown;
}

interface MoralisPayload {
  txs?: MoralisNativeTx[];
  erc20Transfers?: MoralisErc20Transfer[];
  nftTransfers?: MoralisNftTransfer[];
  chainId?: string;
  streamId?: string;
  tag?: string;
  confirmed?: boolean;
  block?: MoralisBlock;
}

// ---------------------------------------------------------------------------
// Native token symbol per Moralis chain ID (for native transfer handling)
// ---------------------------------------------------------------------------

const CHAIN_NATIVE_SYMBOL: Record<string, string> = {
  '0x1': 'ETH',      // Ethereum
  '0x89': 'MATIC',   // Polygon
  '0x38': 'BNB',     // BNB Chain
  '0xa4b1': 'ETH',   // Arbitrum
  '0xa': 'ETH',      // Optimism
  '0x2105': 'ETH',   // Base
  '0xa86a': 'AVAX',  // Avalanche
  'solana': 'SOL',   // Solana
  '0xfa': 'FTM',     // Fantom
  '0xe708': 'ETH',   // Linea
  '0x144': 'ETH',    // zkSync Era
  '0x44d': 'MATIC',  // Polygon zkEVM
  '0x19': 'CRO',     // Cronos
  '0x64': 'XDAI',    // Gnosis
  '0x1388': 'MNT',   // Mantle
};

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

// Converts wei (10^18 units) to a decimal string (e.g., '1000000000000000000' → '1')
function convertWeiToEther(weiStr: string): string {
  if (!weiStr || weiStr === '0') return '0';
  const wei = BigInt(weiStr);
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const remainder = wei % divisor;
  if (remainder === 0n) return whole.toString();
  const decStr = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}.${decStr}`;
}

// Converts token smallest-unit value to decimal string using tokenDecimals
function convertTokenAmount(valueStr: string, decimalsStr: string): string {
  if (!valueStr || valueStr === '0') return '0';
  const decimals = parseInt(decimalsStr || '18', 10);
  const divisor = 10n ** BigInt(decimals);
  const raw = BigInt(valueStr);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const decStr = remainder.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${decStr}`;
}

// ---------------------------------------------------------------------------
// Event ID extraction — idempotency key derivation
// ---------------------------------------------------------------------------

function extractEventId(payload: MoralisPayload, rawBody: string): string {
  if (payload.streamId && payload.chainId && payload.tag !== undefined) {
    return `${payload.streamId}_${payload.chainId}_${payload.tag}`;
  }
  // Fallback: hash of the raw body (guaranteed unique per distinct payload)
  return keccak256(rawBody);
}

// ---------------------------------------------------------------------------
// Portfolio lookup — find connected portfolio by walletAddress + chainId
// ---------------------------------------------------------------------------

async function findConnectedPortfolio(
  walletAddress: string,
  chainId: number,
): Promise<PortfolioWithRelations | null> {
  if (!walletAddress) return null;
  const portfolio = await prisma.portfolio.findFirst({
    where: {
      walletAddress: walletAddress.toLowerCase(),
      chainId,
      type: { name: 'connected' },
    },
    include: { type: true, chain: true },
  });
  return portfolio as PortfolioWithRelations | null;
}

// ---------------------------------------------------------------------------
// Per-transfer processors
// ---------------------------------------------------------------------------

// Per-transfer business outcomes (NONE of these throw — all are deterministic and
// safe to ack+dedupe):
//   'processed' — a Transaction/Nft row was written (or already existed → duplicate)
//   'skipped'   — a genuine BUSINESS skip: unknown chain/token/native-symbol. Retrying
//                 will never succeed, so we ack and dedupe.
//   'no-op'     — the transfer touches no wallet we track; nothing to do, not counted.
// TRANSIENT/UNEXPECTED errors (DB unreachable, Redis down, an unforeseen throw) are NOT
// in this set: the processors RE-THROW them so handleMoralisWebhook 500s WITHOUT setting
// the dedupe key, and Moralis retries the whole payload (retrofit-17 §3). Re-processing
// is idempotent — the transactionHash unique constraint turns an already-written transfer
// into TRANSACTION_HASH_DUPLICATE (counted as processed), and NFT upsert/delete are
// naturally idempotent.
type TransferResult = 'processed' | 'skipped' | 'no-op';

// A duplicate transactionHash means the transfer was ALREADY ingested (the DB unique
// constraint surfaced as TRANSACTION_HASH_DUPLICATE by transactions.service). That is
// idempotent success, NOT a transient failure — count it as processed, never retry.
function isDuplicateHashError(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === 'object' &&
    'code' in e &&
    (e as { code: string }).code === 'TRANSACTION_HASH_DUPLICATE'
  );
}

async function processNativeTx(
  nativeTx: MoralisNativeTx,
  chainId: number,
  moralisChainId: string,
  blockTimestamp: string,
): Promise<{ processed: number; skipped: number }> {
  const fromAddr = (nativeTx.from ?? nativeTx.fromAddress ?? '').toLowerCase();
  const toAddr = (nativeTx.to ?? nativeTx.toAddress ?? '').toLowerCase();
  const txHash = nativeTx.hash;
  const nativeSymbol = CHAIN_NATIVE_SYMBOL[moralisChainId];

  if (!nativeSymbol) {
    console.log('[moralis]', JSON.stringify({
      event: 'moralis_unknown_token',
      symbol: 'native',
      contract: null,
      moralisChainId,
    }));
    return { processed: 0, skipped: 1 };
  }

  let processed = 0;
  let skipped = 0;

  // Direction mapping: IN (to=wallet) → buy, OUT (from=wallet) → sell
  // Connected portfolios reflect on-chain truth — opposite of Stage 9A manual-portfolio
  // transfer=no-op simplification.
  const candidates: Array<{ addr: string; direction: 'buy' | 'sell' }> = [];
  if (toAddr) candidates.push({ addr: toAddr, direction: 'buy' });
  if (fromAddr && fromAddr !== toAddr) candidates.push({ addr: fromAddr, direction: 'sell' });

  for (const { addr, direction } of candidates) {
    const portfolio = await findConnectedPortfolio(addr, chainId);
    if (!portfolio) continue; // graceful no-op — wallet we don't track

    const amount = convertWeiToEther(nativeTx.value ?? '0');

    try {
      await createTransactionFromWebhook({
        portfolio,
        body: {
          type: 'native',
          direction,
          amount,
          symbol: nativeSymbol,
          timestamp: blockTimestamp,
          ...(txHash ? { transactionHash: txHash } : {}),
          from: fromAddr || null,
          to: toAddr || null,
        },
      });
      processed++;
    } catch (e) {
      // Duplicate hash = already ingested → idempotent success, count as processed.
      if (isDuplicateHashError(e)) {
        processed++;
      } else {
        // Transient/unexpected (DB unreachable, etc.) — RE-THROW so the handler 500s
        // and Moralis retries. Counting it as `skipped` would silently ack a lost
        // transfer (retrofit-17 §3).
        console.error('[moralis]', JSON.stringify({ event: 'native_tx_error', hash: txHash }), e);
        throw e;
      }
    }
  }

  return { processed, skipped };
}

async function processErc20Transfer(
  transfer: MoralisErc20Transfer,
  chainId: number,
  blockTimestamp: string,
): Promise<TransferResult> {
  const fromAddr = (transfer.from ?? '').toLowerCase();
  const toAddr = (transfer.to ?? '').toLowerCase();
  const txHash = transfer.transactionHash;
  const symbol = transfer.tokenSymbol;

  if (!symbol) {
    console.log('[moralis]', JSON.stringify({ event: 'moralis_unknown_token', symbol: null, contract: transfer.contract }));
    return 'skipped';
  }

  // Resolve token by symbol — we never auto-create Token rows from webhook data
  const token = await prisma.token.findFirst({
    where: { symbol: { equals: symbol, mode: 'insensitive' } },
  });
  if (!token) {
    console.log('[moralis]', JSON.stringify({
      event: 'moralis_unknown_token',
      symbol,
      contract: transfer.contract,
    }));
    return 'skipped';
  }

  // Find matching portfolio (to=buy, from=sell)
  const candidates: Array<{ addr: string; direction: 'buy' | 'sell' }> = [];
  if (toAddr) candidates.push({ addr: toAddr, direction: 'buy' });
  if (fromAddr && fromAddr !== toAddr) candidates.push({ addr: fromAddr, direction: 'sell' });

  let anyProcessed = false;
  for (const { addr, direction } of candidates) {
    const portfolio = await findConnectedPortfolio(addr, chainId);
    if (!portfolio) continue;

    const amount = convertTokenAmount(transfer.value ?? '0', transfer.tokenDecimals ?? '18');

    try {
      await createTransactionFromWebhook({
        portfolio,
        body: {
          type: 'erc20',
          direction,
          amount,
          symbol: token.symbol,
          tokenContractAddress: transfer.contract ?? '',
          tokenName: transfer.tokenName ?? symbol,
          tokenSymbol: symbol,
          timestamp: blockTimestamp,
          ...(txHash ? { transactionHash: txHash } : {}),
          from: fromAddr || null,
          to: toAddr || null,
        },
      });
      anyProcessed = true;
    } catch (e) {
      // Duplicate hash = already ingested → idempotent success.
      if (isDuplicateHashError(e)) {
        anyProcessed = true;
      } else {
        // Transient/unexpected — RE-THROW so the handler 500s and Moralis retries
        // instead of silently acking a lost transfer (retrofit-17 §3).
        console.error('[moralis]', JSON.stringify({ event: 'erc20_error', hash: txHash }), e);
        throw e;
      }
    }
  }

  return anyProcessed ? 'processed' : 'no-op';
}

async function processNftTransfers(
  nftTransfers: MoralisNftTransfer[],
  chainId: number,
  chainSlug: string,
): Promise<number> {
  let processed = 0;

  for (const transfer of nftTransfers) {
    const fromAddr = (transfer.from ?? '').toLowerCase();
    const toAddr = (transfer.to ?? '').toLowerCase();
    const tokenAddress = (transfer.tokenAddress ?? '').toLowerCase();
    const tokenId = transfer.tokenId ?? '';

    if (!tokenAddress || !tokenId) continue;

    // Check both to (received) and from (sent) directions
    const candidates: Array<{ addr: string; direction: 'received' | 'sent' }> = [];
    if (toAddr) candidates.push({ addr: toAddr, direction: 'received' });
    if (fromAddr && fromAddr !== toAddr) candidates.push({ addr: fromAddr, direction: 'sent' });

    for (const { addr, direction } of candidates) {
      const portfolio = await findConnectedPortfolio(addr, chainId);
      if (!portfolio) continue;

      if (direction === 'received') {
        await prisma.nft.upsert({
          where: {
            portfolioId_contractAddress_tokenId: {
              portfolioId: portfolio.id,
              contractAddress: tokenAddress,
              tokenId,
            },
          },
          create: {
            portfolioId: portfolio.id,
            contractAddress: tokenAddress,
            tokenId,
            name: transfer.tokenName ?? null,
            collectionName: transfer.collectionName ?? null,
            logoUrl: transfer.logoUrl ?? null,
            chain: chainSlug,
            tokenStandard: transfer.tokenStandard ?? null,
            floorPrice: transfer.floorPrice ?? null,
            floorPriceUsd: transfer.floorPriceUsd ?? null,
            lastSale: transfer.lastSale ?? null,
            lastSaleNote: transfer.lastSaleNote ?? null,
            rarity: transfer.rarity ?? null,
            traits: transfer.traits !== undefined
              ? (transfer.traits as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
          update: {
            // Refresh marketplace data if present in this webhook
            ...(transfer.floorPrice !== undefined && { floorPrice: transfer.floorPrice }),
            ...(transfer.floorPriceUsd !== undefined && { floorPriceUsd: transfer.floorPriceUsd }),
            ...(transfer.lastSale !== undefined && { lastSale: transfer.lastSale }),
            ...(transfer.lastSaleNote !== undefined && { lastSaleNote: transfer.lastSaleNote }),
          },
        });
        processed++;
      } else {
        // Ownership transferred away — remove from portfolio
        await prisma.nft.deleteMany({
          where: { portfolioId: portfolio.id, contractAddress: tokenAddress, tokenId },
        });
        processed++;
      }
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

export async function handleMoralisWebhook(c: Context): Promise<Response> {
  // 1. Read raw body BEFORE any JSON parsing — Moralis signs exact bytes
  const rawBody = await c.req.text();

  // 2. Signature verification
  const signature = c.req.header('x-signature');
  if (!signature) {
    return c.json(err('INVALID_SIGNATURE', 'Missing x-signature header'), 401);
  }
  if (!verifyMoralisSignature(rawBody, signature, config.MORALIS_WEBHOOK_SECRET)) {
    return c.json(err('INVALID_SIGNATURE', 'Webhook signature verification failed'), 401);
  }

  // 3. Parse JSON
  let payload: MoralisPayload;
  try {
    payload = JSON.parse(rawBody) as MoralisPayload;
  } catch {
    return c.json(err('MALFORMED_PAYLOAD', 'Request body is not valid JSON'), 400);
  }

  // 4. Idempotency check
  const eventId = extractEventId(payload, rawBody);
  const seen = await redis.get(`moralis_event:${eventId}`);
  if (seen) {
    return c.json(ok({ received: true, duplicate: true }), 200);
  }

  // 5. Resolve chain
  const moralisChainId = payload.chainId ?? '';
  const chain = moralisChainId
    ? await prisma.chain.findUnique({ where: { moralisId: moralisChainId } })
    : null;

  const txs = payload.txs ?? [];
  const erc20Transfers = payload.erc20Transfers ?? [];
  const nftTransfers = payload.nftTransfers ?? [];

  // If chain is unresolvable, count all transfers as skipped
  if (!chain) {
    if (moralisChainId) {
      console.log('[moralis]', JSON.stringify({ event: 'moralis_unknown_chain', chainId: moralisChainId }));
    }
    const skippedCount = txs.length + erc20Transfers.length + nftTransfers.length;
    await redis.set(`moralis_event:${eventId}`, '1', 'EX', REDIS_TTL_30_DAYS);
    return c.json(ok({ received: true, processed: 0, skipped: skippedCount }), 200);
  }

  // Block timestamp (fallback to now if not present)
  const blockTs = payload.block?.timestamp;
  const blockTimestamp = blockTs
    ? new Date(Number(blockTs) * 1000).toISOString()
    : new Date().toISOString();

  let processed = 0;
  let skipped = 0;

  // NOTE: there is NO per-transfer try/catch here. Business skips are RETURNED by
  // the processors (counted below); transient/unexpected errors are RE-THROWN and
  // caught by the single try/catch around the whole loop, which 500s WITHOUT setting
  // the dedupe key so Moralis retries the entire payload (retrofit-17 §3). Swallowing
  // a transient error into `skipped` here would silently ack — and permanently lose —
  // a transfer that a retry would have ingested.
  try {
    // Process native transfers
    for (const nativeTx of txs) {
      const counts = await processNativeTx(nativeTx, chain.id, moralisChainId, blockTimestamp);
      processed += counts.processed;
      skipped += counts.skipped;
    }

    // Process ERC-20 transfers
    for (const erc20 of erc20Transfers) {
      const result = await processErc20Transfer(erc20, chain.id, blockTimestamp);
      if (result === 'processed') processed++;
      else if (result === 'skipped') skipped++;
      // 'no-op' → wallet not tracked, don't count
    }

    // Process NFT transfers — upsert on received, delete on sent
    if (nftTransfers.length > 0) {
      const nftProcessed = await processNftTransfers(nftTransfers, chain.id, chain.slug);
      processed += nftProcessed;
    }
  } catch (e) {
    // Transient/unexpected error — do NOT set the dedupe key so Moralis retries the
    // whole payload (already-written transfers are idempotent on replay: duplicate
    // hashes count as processed, NFT upsert/delete are idempotent).
    console.error('[moralis]', JSON.stringify({ event: 'handler_error', eventId }), e);
    return c.json(err('WEBHOOK_HANDLER_ERROR', 'Internal webhook handler error — retrying'), 500);
  }

  // 6. Set idempotency key ONLY after the whole payload processed without a transient
  //    error (genuine business skips above are deterministic, so acking them is safe).
  await redis.set(`moralis_event:${eventId}`, '1', 'EX', REDIS_TTL_30_DAYS);

  return c.json(ok({ received: true, processed, skipped }), 200);
}
