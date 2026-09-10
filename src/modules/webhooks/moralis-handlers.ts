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
import { z } from 'zod';
import jsSha3 from 'js-sha3';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { config } from '../../lib/config.js';
import { ok, err } from '../../lib/envelope.js';
import { verifyMoralisSignature } from '../../lib/moralis-signature.js';
import { createTransactionFromWebhook } from '../transactions/transactions.service.js';
import { refreshConnectedBalancesFromProvider } from '../wallet-data/sync.js';
import { classifyNftSpam } from '../wallet-data/nft-spam.js';
import { fetchSpamContracts, fetchWalletSpamContracts } from '../wallet-data/index.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';

// js-sha3 is CommonJS with dynamically-built exports — default-import then destructure
// (a named import throws at the real tsx/node boot; vitest's loader masks it). See the
// matching note in lib/moralis-signature.ts. (boot fix)
const { keccak256 } = jsSha3;

import { REDIS_TTL_30_DAYS, CHAIN_NATIVE_SYMBOL, MoralisPayloadSchema, extractEventId, convertWeiToEther, convertTokenAmount, type MoralisPayload, type MoralisNativeTx, type MoralisErc20Transfer, type MoralisNftTransfer } from './moralis.private.js';

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
  // retrofit-59 §2: collects every connected portfolio touched, so the handler can refresh its
  // balances from the provider summary AFTER the feed writes (recalc no longer sets them).
  affected: Map<number, PortfolioWithRelations>,
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

  // Parse the amount once. A malformed value (audit SEC #8/#22) is a DETERMINISTIC skip:
  // ack + dedupe rather than throwing BigInt() into the handler's 500/retry path forever.
  const amount = convertWeiToEther(nativeTx.value ?? '0');
  if (amount === null) {
    console.log('[moralis]', JSON.stringify({ event: 'moralis_malformed_value', kind: 'native', hash: txHash }));
    return { processed: 0, skipped: 1 };
  }

  // Direction mapping: IN (to=wallet) → buy, OUT (from=wallet) → sell
  // Connected portfolios reflect on-chain truth — opposite of Stage 9A manual-portfolio
  // transfer=no-op simplification.
  const candidates: Array<{ addr: string; direction: 'buy' | 'sell' }> = [];
  if (toAddr) candidates.push({ addr: toAddr, direction: 'buy' });
  if (fromAddr && fromAddr !== toAddr) candidates.push({ addr: fromAddr, direction: 'sell' });

  for (const { addr, direction } of candidates) {
    const portfolio = await findConnectedPortfolio(addr, chainId);
    if (!portfolio) continue; // graceful no-op — wallet we don't track
    affected.set(portfolio.id, portfolio); // retrofit-59 §2: refresh its balances after the feed write

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
  affected: Map<number, PortfolioWithRelations>, // retrofit-59 §2: connected portfolios to refresh
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

  // Parse the amount once. A malformed value or out-of-range decimals (audit SEC #8/#22) is a
  // DETERMINISTIC skip: ack + dedupe rather than throwing BigInt() into the 500/retry path.
  const amount = convertTokenAmount(transfer.value ?? '0', transfer.tokenDecimals ?? '18');
  if (amount === null) {
    console.log('[moralis]', JSON.stringify({ event: 'moralis_malformed_value', kind: 'erc20', hash: txHash, contract: transfer.contract }));
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
    affected.set(portfolio.id, portfolio); // retrofit-59 §2: refresh its balances after the feed write

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

  // retrofit-86 (H13.1, defect #3): apply the SAME combined spam verdict the resync uses, not the
  // name-heuristic-only stopgap. The provider spam-contract set is per chain+wallet — memoize it for
  // this webhook so a burst of NFT events doesn't refetch it per transfer (it's also Redis-cached
  // for cross-webhook reuse). Best-effort: any failure leaves an empty set → verdict degrades to
  // blocklist/bulk/heuristic, never throws.
  const spamSetByWallet = new Map<string, Set<string>>();
  const spamSetFor = async (wallet: string): Promise<Set<string>> => {
    const key = wallet.toLowerCase();
    const memo = spamSetByWallet.get(key);
    if (memo) return memo;
    let set = new Set<string>();
    try {
      set = await fetchSpamContracts({ slug: chainSlug });
      const walletSpam = await fetchWalletSpamContracts(wallet, { slug: chainSlug });
      for (const c of walletSpam) set.add(c);
    } catch (e) {
      console.error('[moralis] nft spam-set fetch failed', (e as Error).message);
    }
    spamSetByWallet.set(key, set);
    return set;
  };

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
        // retrofit-86 (H13.1, defect #3): full combined verdict (provider spam-contract set ∪
        // curated blocklist ∪ allowlist ∪ bulk held-count ∪ name heuristic) — same as the resync.
        // heldCount = existing rows from this contract + this arrival, so a bulk airdrop trips the
        // signal in real time without waiting for a manual resync.
        const spamSet = await spamSetFor(addr);
        const existingHeld = await prisma.nft.count({
          where: { portfolioId: portfolio.id, contractAddress: tokenAddress },
        });
        const spam = classifyNftSpam({
          spamContract: spamSet.has(tokenAddress),
          name: transfer.tokenName ?? null,
          collectionName: transfer.collectionName ?? null,
          contractAddress: tokenAddress,
          heldCount: existingHeld + 1,
        });
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
            spam,
          },
          update: {
            // Refresh marketplace data if present in this webhook
            ...(transfer.floorPrice !== undefined && { floorPrice: transfer.floorPrice }),
            ...(transfer.floorPriceUsd !== undefined && { floorPriceUsd: transfer.floorPriceUsd }),
            ...(transfer.lastSale !== undefined && { lastSale: transfer.lastSale }),
            ...(transfer.lastSaleNote !== undefined && { lastSaleNote: transfer.lastSaleNote }),
            spam, // re-evaluate on re-delivery (does not touch the user's spamOverride)
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

  // 3. Parse + structurally validate JSON (audit SEC #22). A 400 here is deterministic, so a
  //    signature-valid-but-malformed body won't trigger an infinite Moralis retry loop.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json(err('MALFORMED_PAYLOAD', 'Request body is not valid JSON'), 400);
  }
  const validation = MoralisPayloadSchema.safeParse(parsed);
  if (!validation.success) {
    console.log('[moralis]', JSON.stringify({ event: 'moralis_invalid_payload' }));
    return c.json(err('MALFORMED_PAYLOAD', 'Request body failed schema validation'), 400);
  }
  const payload = validation.data as MoralisPayload;

  // 3a. Confirmed-only ingestion (audit SEC #18). Moralis sends an UNCONFIRMED delivery on
  //     block inclusion and a CONFIRMED one after enough confirmations. Ingesting the
  //     unconfirmed copy records reorg-able state that is never reconciled. Ack 200 so Moralis
  //     stops retrying, but do NOT ingest and do NOT set a dedupe key — the confirmed delivery
  //     carries `confirmed:true`, so its raw body (and thus its hash key) differs and is still
  //     ingested.
  if (payload.confirmed !== true) {
    return c.json(ok({ received: true, confirmed: false, ignored: true }), 200);
  }

  // 4. Idempotency check
  const eventId = extractEventId(rawBody);
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

  // Block timestamp (fallback to now if absent or non-numeric). Guard Number() → NaN, which
  // would make new Date(NaN).toISOString() throw "Invalid time value" on garbage input.
  const blockTs = payload.block?.timestamp;
  const blockTsSeconds = blockTs != null ? Number(blockTs) : NaN;
  const blockTimestamp = Number.isFinite(blockTsSeconds)
    ? new Date(blockTsSeconds * 1000).toISOString()
    : new Date().toISOString();

  let processed = 0;
  let skipped = 0;
  // retrofit-59 §2: connected portfolios whose fungible balance a transfer touched. After the
  // feed writes, their balances are refreshed from the provider summary (recalc no longer sets
  // them for connected — §1). NFT-only transfers never touch a fungible balance, so the NFT path
  // doesn't populate this.
  const affected = new Map<number, PortfolioWithRelations>();

  // NOTE: there is NO per-transfer try/catch here. Business skips are RETURNED by
  // the processors (counted below); transient/unexpected errors are RE-THROWN and
  // caught by the single try/catch around the whole loop, which 500s WITHOUT setting
  // the dedupe key so Moralis retries the entire payload (retrofit-17 §3). Swallowing
  // a transient error into `skipped` here would silently ack — and permanently lose —
  // a transfer that a retry would have ingested.
  try {
    // Process native transfers
    for (const nativeTx of txs) {
      const counts = await processNativeTx(nativeTx, chain.id, moralisChainId, blockTimestamp, affected);
      processed += counts.processed;
      skipped += counts.skipped;
    }

    // Process ERC-20 transfers
    for (const erc20 of erc20Transfers) {
      const result = await processErc20Transfer(erc20, chain.id, blockTimestamp, affected);
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
    return c.json(err('WEBHOOK_HANDLER_ERROR', 'Internal webhook handler error. Retrying'), 500);
  }

  // 6. Set idempotency key ONLY after the whole payload processed without a transient
  //    error (genuine business skips above are deterministic, so acking them is safe).
  await redis.set(`moralis_event:${eventId}`, '1', 'EX', REDIS_TTL_30_DAYS);

  // 7. retrofit-59 §2: refresh each touched connected portfolio's balances from the provider
  //    (the live counterpart of resync's balances-only set). Best-effort PER portfolio — the
  //    helper swallows its own errors, so a provider failure never affects the 200/dedupe above;
  //    the balance just stays as-is until the next sync. Done AFTER the dedupe key so a refresh
  //    failure can't trigger a Moralis retry of the (already-acked) feed write.
  for (const portfolio of affected.values()) {
    await refreshConnectedBalancesFromProvider(portfolio);
  }

  return c.json(ok({ received: true, processed, skipped }), 200);
}
