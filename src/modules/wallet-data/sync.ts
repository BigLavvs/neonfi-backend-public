// Neonfi backend — initial holdings sync for connected portfolios (retrofit-47, retrofit-48).
//
// Runs ONCE at connect time (createPortfolio, connected branch), best-effort: seeds the
// wallet's CURRENT holdings so the portfolio shows them immediately. The Moralis stream
// keeps it updated afterward — the stream only captures transfers AFTER creation, so
// seeding the current balance now + future webhook deltas = correct (no double counting).
//
// ACCURACY FIX vs the webhook stream path (moralis-handlers skips unknown tokens to keep
// spam airdrops out of the catalog): here the provider already gave us a real balance +
// price and the provider layer already excluded spam/dust, so a non-catalog holding is
// AUTO-LISTED rather than dropped — the initial sync reflects the user's real bag.
//
// retrofit-48: resolution is now contract-first (the on-chain identity) with a symbol
// fallback, and auto-listed rows carry `contractAddress` + `autoListed: true` so the
// connected-reprice job can refresh their (off-firehose) price by contract.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { seedAcquisitionInTx, invalidatePnlCache } from '../transactions/transactions.service.js';
import { fetchWalletSummary } from './index.js';
import type { WalletToken } from './types.js';

// Decimal(20,8) column scale — format without exponent notation so Prisma accepts it.
function dec8(n: number): string {
  return n.toFixed(8);
}

// Resolve a wallet token to its catalog row, auto-listing it when no row exists.
//
// `symbol` stays the UNIQUE catalog key (re-keying to (symbol, contract) is out of scope),
// so there is still exactly one row per ticker. `contractAddress` makes resolution PRECISE:
// we match on the on-chain identity first and only fall back to the ticker.
async function resolveOrCreateToken(t: WalletToken) {
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
        logoUrl: null,
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

export async function syncConnectedHoldings(
  portfolioId: number,
  address: string,
  chain: { slug: string },
): Promise<void> {
  const summary = await fetchWalletSummary(address, chain);
  if (!summary || summary.tokens.length === 0) return;

  let seededAny = false;
  for (const t of summary.tokens) {
    if (!(t.balance > 0) || !t.symbol) continue;
    try {
      // Resolve OR auto-create the catalog Token (contract-first, symbol fallback). An
      // existing catalog row is left untouched for name/price/rank (the catalog is
      // authoritative); only a missing contract is backfilled onto it.
      const token = await resolveOrCreateToken(t);

      // Seed an opening position for the current balance via the shared acquisition seed
      // (native buy). priceAtTime = the provider's per-unit price ⇒ cost basis ≈ current
      // value ⇒ unrealized PnL starts ≈ 0; omit when the provider couldn't price it.
      // Each token's seed is its own atomic $transaction so one bad token can't abort the
      // rest. The asset is upserted first because seedAcquisitionInTx recalcs an EXISTING
      // asset row.
      await prisma.$transaction(
        async (tx) => {
          await tx.asset.upsert({
            where: { portfolioId_tokenId: { portfolioId, tokenId: token.id } },
            update: {},
            create: { portfolioId, tokenId: token.id },
          });
          await seedAcquisitionInTx(tx, {
            portfolioId,
            tokenId: token.id,
            symbol: token.symbol,
            amount: dec8(t.balance),
            ...(t.usdPrice != null ? { priceAtTime: dec8(t.usdPrice) } : {}),
          });
        },
        { timeout: 15000 },
      );
      seededAny = true;
    } catch (e) {
      // Per-token failure: log & continue — one bad token must not abort the rest.
      console.error('[wallet-sync] token seed failed', { symbol: t.symbol }, (e as Error).message);
    }
  }

  // Mirror the manual-create seeding path: recalc happens inside seedAcquisitionInTx;
  // flush the derived PnL/analytics caches once after the loop.
  if (seededAny) await invalidatePnlCache(portfolioId);
}
