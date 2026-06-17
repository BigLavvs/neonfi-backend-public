import { prisma } from '../../../lib/prisma.js';
import { redis } from '../../../lib/redis.js';
import { config } from '../../../lib/config.js';
import type { TokenMetadataProvider } from './provider.js';
import { CoinMarketCapTokenMetadataProvider } from './coinmarketcap-provider.js';

let _defaultProvider: TokenMetadataProvider | null = null;

function getDefaultProvider(): TokenMetadataProvider {
  if (!_defaultProvider) {
    _defaultProvider = new CoinMarketCapTokenMetadataProvider(config.COINMARKETCAP_API_KEY);
  }
  return _defaultProvider;
}

export async function runTokenMetadataSync(
  provider?: TokenMetadataProvider,
): Promise<{ updated: number; skipped: number; failed: number; durationMs: number }> {
  const p = provider ?? getDefaultProvider();
  const t0 = Date.now();

  const tokens = await prisma.token.findMany({ select: { symbol: true } });
  const symbols = tokens.map((t) => t.symbol);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const metadata = await p.fetchMetadata(symbols);

    for (const symbol of symbols) {
      const meta = metadata.get(symbol);
      if (!meta) {
        skipped++;
        continue;
      }
      try {
        await prisma.token.update({
          where: { symbol },
          data: {
            currentPrice: meta.currentPrice,
            marketCap: meta.marketCap,
            // undefined means "don't overwrite" in Prisma — rank:null from provider
            // should not clear an existing rank value.
            ...(meta.rank !== null ? { rank: meta.rank } : {}),
            // retrofit-39: persist the 24h change as the cold-cache badge fallback. Like
            // rank, only write a real value — a missing change must not null out the prior.
            ...(meta.change24h != null ? { change24h: meta.change24h } : {}),
          },
        });
        await redis.del(`token_meta:${symbol}`);
        updated++;
      } catch (e) {
        failed++;
        console.error(`[token-sync] failed to update ${symbol}:`, e);
      }
    }
  } catch (e) {
    console.error('[token-sync] provider fetch failed:', e);
    failed = symbols.length;
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[token-sync] complete vendor=${p.name} updated=${updated} skipped=${skipped} failed=${failed} duration=${durationMs}ms`,
  );
  return { updated, skipped, failed, durationMs };
}
