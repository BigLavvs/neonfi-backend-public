// Neonfi backend — periodic re-price of auto-listed connected-wallet tokens (retrofit-48).
//
// Tokens auto-listed from a connected wallet (sync.ts) are NOT on the live exchange firehose
// (it subscribes by symbol to majors), so their Token.currentPrice freezes at sync time and
// the connected portfolio's total drifts. This worker re-reads every connected wallet that
// holds ≥1 auto-listed token and refreshes ONLY those tokens' currentPrice — matched by
// CONTRACT when available (precise), else by symbol, and always scoped to autoListed:true so
// a CMC/firehose-priced token is never clobbered.
//
// Balances stay owned by the Moralis webhook stream; this is price-only.

import { prisma } from '../../lib/prisma.js';
import { fetchWalletSummary } from './index.js';
import { reconcileTokenPrice } from '../tokens/canonical-price.js';

const DELAY_MS = 250; // gentle pacing between wallets (provider rate limits)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Decimal(20,8) column scale — format without exponent notation so Prisma accepts it.
function dec8(n: number): string {
  return n.toFixed(8);
}

// Best-effort: never throws; per-wallet failures are logged and skipped. Returns counts for
// the scheduler log.
export async function repriceConnectedTokens(): Promise<{ wallets: number; repriced: number }> {
  // Every (walletAddress, chainSlug) of a connected portfolio holding an auto-listed token.
  const assets = await prisma.asset.findMany({
    where: {
      token: { autoListed: true },
      portfolio: { type: { name: 'connected' }, walletAddress: { not: null } },
    },
    select: {
      portfolio: { select: { walletAddress: true, chain: { select: { slug: true } } } },
    },
  });

  const wallets = new Map<string, { address: string; slug: string }>();
  for (const a of assets) {
    const address = a.portfolio.walletAddress;
    const slug = a.portfolio.chain?.slug;
    if (!address || !slug) continue;
    wallets.set(`${address}|${slug}`, { address, slug });
  }

  let repriced = 0;
  for (const { address, slug } of wallets.values()) {
    try {
      const summary = await fetchWalletSummary(address, { slug });
      if (!summary) continue;
      for (const t of summary.tokens) {
        // retrofit-71 (C4): cross-check the provider price against a canonical feed (CoinGecko by
        // contract). reconcileTokenPrice prefers canonical when the provider is >25% off (the PEPU
        // 3.7× case), keeps the provider when confirmed, and flags 'unverified' when no canonical
        // listing exists. Nothing to check AND no provider price → skip.
        if (t.usdPrice == null && !t.contractAddress) continue;
        const { price, priceConfidence } = await reconcileTokenPrice(slug, t.contractAddress, t.usdPrice);
        if (price == null) continue; // no canonical and no provider price → leave the row as-is
        // Match auto-listed rows by CONTRACT when available (precise), else by symbol.
        const where = t.contractAddress
          ? {
              contractAddress: { equals: t.contractAddress.toLowerCase(), mode: 'insensitive' as const },
              autoListed: true,
            }
          : { symbol: { equals: t.symbol, mode: 'insensitive' as const }, autoListed: true };
        const res = await prisma.token.updateMany({
          where,
          data: { currentPrice: dec8(price), priceConfidence },
        });
        repriced += res.count;
      }
    } catch (e) {
      console.error('[connected-reprice] wallet failed', { slug }, e);
    }
    await sleep(DELAY_MS);
  }

  return { wallets: wallets.size, repriced };
}
