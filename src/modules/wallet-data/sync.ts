// Neonfi backend — connected-portfolio history import (retrofit-47/48, reworked retrofit-49).
//
// Runs ONCE at connect time (createPortfolio, connected branch), best-effort. retrofit-47
// seeded a single synthetic "opening" buy per held token, so every connected transaction
// showed the sync date with no hash/from/to/gas and a placeholder value. retrofit-49 replaces
// that with the wallet's REAL transfers:
//
//   1. Import the first page (~100) of real transfers (native + ERC-20 + NFT) with their REAL
//      block time, hash, from/to, gas, amount, and historical USD value (#3, #4).
//   2. Import current NFT holdings (which may predate the transfer window) AND NFT transfer
//      history (#2).
//   3. Reconcile a RESIDUAL opening lot per held token = providerCurrentBalance − netImported,
//      dated just before the earliest imported transfer, so the displayed balance still equals
//      the on-chain balance exactly and value history can be rebuilt from start + transactions
//      (#7, #9). When there is NO history (Solana / empty page) this reduces to the old
//      behaviour: the residual = the full balance → one opening lot per holding.
//   4. Persist the provider pagination cursor + total tx count for the "load more" endpoint
//      (#5, #8).
//
// The Moralis stream keeps the portfolio updated AFTER creation; this seeds the past. Every
// step is per-item best-effort — one bad token/transfer logs and continues, and the whole sync
// is wrapped by the caller so a failure still leaves the portfolio created.
//
// retrofit-48: token resolution is contract-first (the on-chain identity) with a symbol
// fallback; auto-listed rows carry `contractAddress` + `autoListed: true` so the
// connected-reprice job can refresh their (off-firehose) price by contract.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { toDecimalString } from '../../lib/decimal.js';
import {
  seedAcquisitionInTx,
  invalidatePnlCache,
  createTransactionFromWebhook,
  createNftTransactionFromWebhook,
  reconcileWalletOpeningLot,
  WALLET_SYNC_OPENING_NOTE,
  TransactionError,
} from '../transactions/transactions.service.js';
import type { CreateTransactionBody } from '../transactions/transactions.schemas.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { fetchWalletSummary, fetchTransferPage, fetchNftHoldings } from './index.js';
import type { WalletNftHolding, WalletTransfer } from './types.js';

// How many transfers to pull per page (initial sync + each "load more").
const PAGE_LIMIT = 100;
// Below this the residual is float noise / dust — don't seed a reconciling lot for it.
const RESIDUAL_EPSILON = 1e-8;

// Decimal(20,8) column scale for PRICES (kept at full 8-dp, unlike trimmed amounts).
function dec8(n: number): string {
  return n.toFixed(8);
}

interface TokenResolveInput {
  symbol: string;
  name: string | null;
  contractAddress: string | null;
  usdPrice: number | null;
  logoUrl?: string | null;
}

// Resolve a wallet token to its catalog row, auto-listing it when no row exists.
//
// `symbol` stays the UNIQUE catalog key (re-keying to (symbol, contract) is out of scope),
// so there is still exactly one row per ticker. `contractAddress` makes resolution PRECISE:
// we match on the on-chain identity first and only fall back to the ticker. retrofit-49 also
// backfills a missing `logoUrl` from the provider so transactions can render the token image.
async function resolveOrCreateToken(t: TokenResolveInput) {
  const symbol = t.symbol.toUpperCase();
  // Lower-case EVM contracts to match the wallet-validator's normalization; Solana mints are
  // case-sensitive but arrive already-normalized from the provider, so .toLowerCase() is a
  // no-op risk we accept here (native/Solana flows resolve by symbol anyway).
  const contract = t.contractAddress ? t.contractAddress.toLowerCase() : null;

  // 1. Resolve precisely — contract is the on-chain identity, so try it FIRST when present.
  let token =
    contract != null
      ? await prisma.token.findFirst({
          where: { contractAddress: { equals: contract, mode: 'insensitive' } },
        })
      : null;
  const matchedByContract = token != null;

  // Fall back to the symbol match (native tokens, with no contract, resolve here too).
  if (!token) {
    token = await prisma.token.findFirst({
      where: { symbol: { equals: t.symbol, mode: 'insensitive' } },
    });
  }

  if (token) {
    if (!matchedByContract && contract != null) {
      if (token.contractAddress == null) {
        // 2. Backfill the contract on a symbol match so future resolves are precise. (Only
        //    when the row has no contract yet — never overwrite a different one.)
        token = await prisma.token.update({
          where: { id: token.id },
          data: { contractAddress: contract },
        });
      } else if (token.contractAddress.toLowerCase() !== contract) {
        // 3. Genuine same-ticker / different-project collision. `symbol` is UNIQUE so we
        //    cannot create a second row — map the holding to the existing row (never drop)
        //    and log it. This is the documented limitation; the catalog re-key to
        //    (symbol, contractAddress) — which would touch the firehose, webhook, and
        //    transactions — is explicitly out of scope for this retrofit.
        console.warn('[wallet-sync] ticker collision', {
          symbol,
          existing: token.contractAddress,
          incoming: contract,
        });
      }
    }
    // retrofit-49: backfill a missing logo from the provider (never overwrite an existing one).
    if (token.logoUrl == null && t.logoUrl) {
      token = await prisma.token.update({ where: { id: token.id }, data: { logoUrl: t.logoUrl } });
    }
    return token;
  }

  // 4. Nothing matched → auto-list. autoListed:true marks the row for the connected-reprice
  //    job (it is NOT on the live exchange firehose, which subscribes by symbol to majors).
  //    LIVE-PRICING CAVEAT: until the reprice job runs, the value holds at the synced price.
  //    Guard the unique-symbol create against a concurrent same-symbol insert (across
  //    portfolios) — on P2002 re-resolve to the now-existing row.
  try {
    return await prisma.token.create({
      data: {
        symbol,
        name: t.name ?? t.symbol,
        currentPrice: t.usdPrice != null ? dec8(t.usdPrice) : '0',
        rank: null,
        logoUrl: t.logoUrl ?? null,
        autoListed: true,
        contractAddress: contract,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.token.findFirst({
        where: { symbol: { equals: t.symbol, mode: 'insensitive' } },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

function isDuplicateHash(e: unknown): boolean {
  return e instanceof TransactionError && e.code === 'TRANSACTION_HASH_DUPLICATE';
}

// Import one native/erc20 transfer as a real transaction. direction: in→buy, out→sell.
// amount/gas trimmed to Decimal(20,8); usdValue is the provider's HISTORICAL value at tx time
// (override). Returns true when a row was created, false when the hash was already imported
// (dedupe via the unique constraint — also how a multi-asset tx's extra legs collapse).
async function importFungibleTransfer(
  portfolio: PortfolioWithRelations,
  tr: WalletTransfer,
): Promise<boolean> {
  if (!tr.symbol) return false;
  const token = await resolveOrCreateToken({
    symbol: tr.symbol,
    name: tr.name,
    contractAddress: tr.contractAddress,
    usdPrice: null, // history carries no per-unit price; valuation comes from usdValue
    logoUrl: tr.logoUrl,
  });

  const direction = tr.direction === 'in' ? 'buy' : 'sell';
  const amount = toDecimalString(tr.amount);
  const gasFee = tr.gasFee != null ? toDecimalString(tr.gasFee) : null;

  const body: CreateTransactionBody =
    tr.type === 'native'
      ? {
          type: 'native',
          direction,
          amount,
          symbol: token.symbol,
          timestamp: tr.timestamp,
          ...(tr.hash ? { transactionHash: tr.hash } : {}),
          from: tr.from,
          to: tr.to,
          gasFee,
        }
      : {
          type: 'erc20',
          direction,
          amount,
          symbol: token.symbol,
          tokenContractAddress: tr.contractAddress ?? '',
          tokenName: tr.name ?? token.symbol,
          tokenSymbol: tr.symbol,
          timestamp: tr.timestamp,
          ...(tr.hash ? { transactionHash: tr.hash } : {}),
          from: tr.from,
          to: tr.to,
          gasFee,
        };

  try {
    await createTransactionFromWebhook({ portfolio, body, usdValueOverride: tr.usdValue });
    return true;
  } catch (e) {
    if (isDuplicateHash(e)) return false;
    throw e;
  }
}

// Import one NFT transfer: maintain the Nft holdings row (upsert on in, delete on out —
// both idempotent) AND record the transfer as an nft transaction (skip on duplicate hash).
async function importNftTransfer(
  portfolio: PortfolioWithRelations,
  tr: WalletTransfer,
): Promise<boolean> {
  const contract = (tr.contractAddress ?? '').toLowerCase();
  const tokenId = tr.nftTokenId ?? '';
  if (!contract || !tokenId) return false;
  const chainSlug = portfolio.chain?.slug ?? '';

  if (tr.direction === 'in') {
    await prisma.nft.upsert({
      where: {
        portfolioId_contractAddress_tokenId: { portfolioId: portfolio.id, contractAddress: contract, tokenId },
      },
      create: {
        portfolioId: portfolio.id,
        contractAddress: contract,
        tokenId,
        name: tr.name ?? null,
        collectionName: tr.collectionName ?? null,
        logoUrl: tr.logoUrl ?? null,
        chain: chainSlug,
      },
      update: {
        ...(tr.logoUrl ? { logoUrl: tr.logoUrl } : {}),
        ...(tr.name ? { name: tr.name } : {}),
      },
    });
  } else {
    await prisma.nft.deleteMany({
      where: { portfolioId: portfolio.id, contractAddress: contract, tokenId },
    });
  }

  try {
    await createNftTransactionFromWebhook({
      portfolio,
      body: {
        direction: tr.direction === 'in' ? 'buy' : 'sell',
        tokenContractAddress: contract,
        nftTokenId: tokenId,
        ...(tr.name ? { nftName: tr.name } : {}),
        ...(tr.collectionName ? { collectionName: tr.collectionName } : {}),
        timestamp: tr.timestamp,
        ...(tr.hash ? { transactionHash: tr.hash } : {}),
        from: tr.from,
        to: tr.to,
        gasFee: tr.gasFee != null ? toDecimalString(tr.gasFee) : null,
      },
    });
    return true;
  } catch (e) {
    if (isDuplicateHash(e)) return false;
    throw e;
  }
}

// Import a page of transfers oldest→newest (so balances build forward). Per-item best-effort.
// Returns the number of transactions actually created (excludes duplicates/errors).
async function importTransfers(
  portfolio: PortfolioWithRelations,
  transfers: WalletTransfer[],
): Promise<number> {
  // The provider returns DESC (newest first); replay oldest→newest.
  const ordered = [...transfers].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let imported = 0;
  for (const tr of ordered) {
    try {
      const did =
        tr.type === 'nft'
          ? await importNftTransfer(portfolio, tr)
          : await importFungibleTransfer(portfolio, tr);
      if (did) imported += 1;
    } catch (e) {
      console.error('[wallet-sync] transfer import failed', { hash: tr.hash, type: tr.type }, (e as Error).message);
    }
  }
  return imported;
}

// Upsert the wallet's CURRENT NFT holdings (predating the transfer window). Per-item best-effort.
async function importNftHoldings(
  portfolio: PortfolioWithRelations,
  holdings: WalletNftHolding[],
): Promise<void> {
  const chainSlug = portfolio.chain?.slug ?? '';
  for (const h of holdings) {
    try {
      await prisma.nft.upsert({
        where: {
          portfolioId_contractAddress_tokenId: {
            portfolioId: portfolio.id,
            contractAddress: h.contractAddress,
            tokenId: h.tokenId,
          },
        },
        create: {
          portfolioId: portfolio.id,
          contractAddress: h.contractAddress,
          tokenId: h.tokenId,
          name: h.name,
          collectionName: h.collectionName,
          logoUrl: h.logoUrl,
          chain: chainSlug,
          tokenStandard: h.tokenStandard,
        },
        update: {
          ...(h.logoUrl ? { logoUrl: h.logoUrl } : {}),
          ...(h.name ? { name: h.name } : {}),
        },
      });
    } catch (e) {
      console.error('[wallet-sync] nft holding import failed', { contract: h.contractAddress, tokenId: h.tokenId }, (e as Error).message);
    }
  }
}

// Reconcile each held token's balance to the on-chain truth: residual = providerBalance −
// (balance built from the imported transfers). When the residual is meaningful, seed ONE
// opening lot for it (the "starting balance"), dated just before the earliest import so the
// chart can rebuild value from start + transactions. With no transfers the residual is the
// full balance, so this degrades to one opening lot per holding (the retrofit-47 behaviour).
async function reconcileOpeningLots(
  portfolioId: number,
  held: Array<{ tokenId: number; symbol: string; balance: number; usdPrice: number | null }>,
  openingAt: Date,
): Promise<void> {
  for (const h of held) {
    try {
      const asset = await prisma.asset.findUnique({
        where: { portfolioId_tokenId: { portfolioId, tokenId: h.tokenId } },
      });
      const current = asset ? Number(asset.balance.toString()) : 0;
      const residual = h.balance - current;
      if (residual <= RESIDUAL_EPSILON) continue;

      await prisma.$transaction(
        async (tx) => {
          await tx.asset.upsert({
            where: { portfolioId_tokenId: { portfolioId, tokenId: h.tokenId } },
            update: {},
            create: { portfolioId, tokenId: h.tokenId },
          });
          await seedAcquisitionInTx(tx, {
            portfolioId,
            tokenId: h.tokenId,
            symbol: h.symbol,
            amount: toDecimalString(residual),
            timestamp: openingAt.toISOString(),
            // retrofit-50: tag the reconciling lot so a later resync UPDATES it in place
            // (idempotent) instead of inserting a duplicate.
            notes: WALLET_SYNC_OPENING_NOTE,
            ...(h.usdPrice != null ? { priceAtTime: dec8(h.usdPrice) } : {}),
          });
        },
        { timeout: 15000 },
      );
    } catch (e) {
      console.error('[wallet-sync] opening-lot reconcile failed', { symbol: h.symbol }, (e as Error).message);
    }
  }
}

interface HeldToken {
  tokenId: number;
  symbol: string;
  balance: number;
  usdPrice: number | null;
}

// Resolve/auto-list every held token from the provider summary (creating catalog rows with
// price/contract/logo) and return the held list. Done BEFORE importing transfers so a transfer
// for an auto-listed token resolves to a row that already carries the right price. Per-token
// best-effort — a token that can't be resolved (e.g. an over-long symbol) is logged & skipped.
async function resolveHeldTokens(
  summary: Awaited<ReturnType<typeof fetchWalletSummary>>,
): Promise<HeldToken[]> {
  const held: HeldToken[] = [];
  for (const t of summary?.tokens ?? []) {
    if (!(t.balance > 0) || !t.symbol) continue;
    try {
      const token = await resolveOrCreateToken({
        symbol: t.symbol,
        name: t.name,
        contractAddress: t.contractAddress,
        usdPrice: t.usdPrice,
      });
      held.push({ tokenId: token.id, symbol: token.symbol, balance: t.balance, usdPrice: t.usdPrice });
    } catch (e) {
      console.error('[wallet-sync] token resolve failed', { symbol: t.symbol }, (e as Error).message);
    }
  }
  return held;
}

// The opening lot is dated just before the earliest imported transfer (or now if none) so the
// chart can rebuild value from the starting balance forward.
function openingDateFor(transfers: WalletTransfer[]): Date {
  const earliest = transfers.reduce<number | null>((min, tr) => {
    const ts = Date.parse(tr.timestamp);
    return Number.isFinite(ts) && (min === null || ts < min) ? ts : min;
  }, null);
  return earliest !== null ? new Date(earliest - 1000) : new Date();
}

export async function syncConnectedHoldings(
  portfolioId: number,
  address: string,
  chain: { slug: string },
): Promise<void> {
  // Need the full portfolio (type + chain) for the webhook-style transaction writes.
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio) return;

  // Current balances (for reconciliation) + the first page of real history, in parallel.
  const [summary, page] = await Promise.all([
    fetchWalletSummary(address, chain),
    fetchTransferPage(address, chain, { limit: PAGE_LIMIT }),
  ]);

  // Pass 1: pre-resolve held tokens (so prices/contract/logo exist before import).
  const held = await resolveHeldTokens(summary);

  // Pass 2: import the real transfer history (native + erc20 + nft transactions + Nft rows).
  const transfers = page?.transfers ?? [];
  await importTransfers(portfolio, transfers);

  // Pass 3: import the wallet's current NFT holdings (may predate the transfer window).
  const nftHoldings = await fetchNftHoldings(address, chain);
  if (nftHoldings && nftHoldings.length > 0) await importNftHoldings(portfolio, nftHoldings);

  // Pass 4: reconcile the residual opening lots, dated just before the earliest import.
  if (held.length > 0) await reconcileOpeningLots(portfolioId, held, openingDateFor(transfers));

  // Pass 5: persist the cursor + provider total for the "load more" endpoint (#5/#8).
  await prisma.portfolio.update({
    where: { id: portfolioId },
    data: { syncCursor: page?.nextCursor ?? null, externalTxCount: page?.totalCount ?? null },
  });

  // Flush the derived PnL/analytics caches once after the whole sync.
  await invalidatePnlCache(portfolioId);
}

// retrofit-50: idempotent RESYNC for a connected portfolio (POST /portfolios/:id/resync).
// Catches transfers a missed/late webhook never delivered and re-reconciles the balance to
// on-chain. Reuses the retrofit-49 import path but every step is idempotent:
//   - Re-import the latest transfer page — dedupe on tx hash (the unique constraint makes
//     already-recorded transfers no-ops; only genuinely missed ones insert).
//   - Re-import current NFT holdings (upsert); the page's in/out NFT transfers also replay.
//   - Re-reconcile each held token by UPDATING its tagged opening lot (never inserting a new
//     one), so running resync twice in a row changes nothing.
// Best-effort throughout; returns { importedTransfers, reconciled }. The "load more" cursor is
// intentionally left untouched (resync re-reads the newest page; older pages stay deduped).
export async function resyncConnectedHoldings(
  portfolioId: number,
  address: string | null,
  chain: { slug: string } | null,
): Promise<{ importedTransfers: number; reconciled: number }> {
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio || !address || !chain) return { importedTransfers: 0, reconciled: 0 };

  const [summary, page] = await Promise.all([
    fetchWalletSummary(address, chain),
    fetchTransferPage(address, chain, { limit: PAGE_LIMIT }),
  ]);

  // Resolve held tokens (refreshes prices/contract/logo + the held list).
  const held = await resolveHeldTokens(summary);

  // Re-import the latest transfer page (missed transfers insert; recorded ones are no-ops).
  const transfers = page?.transfers ?? [];
  const importedTransfers = await importTransfers(portfolio, transfers);

  // Re-import current NFT holdings (upsert).
  const nftHoldings = await fetchNftHoldings(address, chain);
  if (nftHoldings && nftHoldings.length > 0) await importNftHoldings(portfolio, nftHoldings);

  // Re-reconcile by UPDATING the tagged opening lot per held token (idempotent).
  const openingAt = openingDateFor(transfers).toISOString();
  let reconciled = 0;
  for (const h of held) {
    try {
      await reconcileWalletOpeningLot({
        portfolio,
        tokenId: h.tokenId,
        symbol: h.symbol,
        providerBalance: h.balance,
        usdPrice: h.usdPrice,
        openingAt,
      });
      reconciled += 1;
    } catch (e) {
      console.error('[wallet-sync] resync reconcile failed', { symbol: h.symbol }, (e as Error).message);
    }
  }

  // Refresh the provider total (keeps the overview count fresh); leave syncCursor alone.
  if (page?.totalCount != null) {
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { externalTxCount: page.totalCount },
    });
  }

  await invalidatePnlCache(portfolioId);
  return { importedTransfers, reconciled };
}

// retrofit-49 §6: import the NEXT page of transfers for a connected portfolio (the frontend's
// "Load more"). Reads the stored cursor, imports the page exactly like the initial sync's
// transfer pass (same resolution/trim/dedupe), advances the cursor, and returns the count +
// the next cursor. A manual portfolio, a missing wallet, or a null cursor (no more / done) →
// { imported: 0, nextCursor: null }. NOTE: this does NOT re-reconcile the opening lot — older
// transfers are already folded into the residual seeded at connect time, so they appear in the
// activity feed without re-deriving the starting balance (a full re-reconcile is future work).
export async function importMoreTransfers(
  portfolioId: number,
): Promise<{ imported: number; nextCursor: string | null }> {
  const portfolio = await findPortfolioById(portfolioId);
  if (
    !portfolio ||
    portfolio.type.name !== 'connected' ||
    !portfolio.walletAddress ||
    !portfolio.chain ||
    !portfolio.syncCursor
  ) {
    return { imported: 0, nextCursor: null };
  }

  const page = await fetchTransferPage(
    portfolio.walletAddress,
    { slug: portfolio.chain.slug },
    { cursor: portfolio.syncCursor, limit: PAGE_LIMIT },
  );
  if (!page) {
    // Provider can't continue — clear the cursor so the UI stops offering "load more".
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { syncCursor: null } });
    return { imported: 0, nextCursor: null };
  }

  const imported = await importTransfers(portfolio, page.transfers);
  await prisma.portfolio.update({
    where: { id: portfolioId },
    data: { syncCursor: page.nextCursor ?? null },
  });
  if (imported > 0) await invalidatePnlCache(portfolioId);
  return { imported, nextCursor: page.nextCursor ?? null };
}
