// Neonfi backend — initial holdings sync for connected portfolios (retrofit-47).
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

import { prisma } from '../../lib/prisma.js';
import { seedAcquisitionInTx, invalidatePnlCache } from '../transactions/transactions.service.js';
import { fetchWalletSummary } from './index.js';

// Decimal(20,8) column scale — format without exponent notation so Prisma accepts it.
function dec8(n: number): string {
  return n.toFixed(8);
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
      const symbol = t.symbol.toUpperCase();
      // Resolve OR auto-create the catalog Token. The Token model has no contract-address
      // column, so we match/key on the unique `symbol`. upsert makes re-syncs idempotent
      // and concurrent creates across portfolios race-safe. An existing catalog row is
      // left untouched (the catalog is authoritative for name/price/rank).
      const token = await prisma.token.upsert({
        where: { symbol },
        update: {},
        create: {
          symbol,
          name: t.name ?? t.symbol,
          // LIVE-PRICING CAVEAT: auto-listed tokens are NOT in the live price firehose
          // (it subscribes by symbol to exchange WS streams), so their value holds at the
          // synced price until a future refresh — accurate at sync time, and far better
          // than dropping real holdings. A later retrofit can fold these into a periodic
          // price refresh / re-sync.
          currentPrice: t.usdPrice != null ? dec8(t.usdPrice) : '0',
          rank: null,
          logoUrl: null,
        },
      });

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
