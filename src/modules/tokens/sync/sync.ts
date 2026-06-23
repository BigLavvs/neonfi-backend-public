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

    // Only the symbols the provider returned metadata for get updated; the rest are skipped.
    const toUpdate = symbols.filter((s) => metadata.get(s));
    skipped = symbols.length - toUpdate.length;

    // perf #25: chunked bounded-concurrency updates instead of ~500 sequential awaits, then ONE
    // multi-key redis.del for the rows we actually updated (was a per-token DEL round trip).
    const succeeded: string[] = [];
    const CHUNK = 20;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const results = await Promise.all(
        toUpdate.slice(i, i + CHUNK).map(async (symbol) => {
          const meta = metadata.get(symbol)!;
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
                // retrofit-40: repair stale/null logos on the 6-hourly sync; only write when
                // provided so a logo-less metadata response never clears a good logoUrl.
                ...(meta.logoUrl ? { logoUrl: meta.logoUrl } : {}),
              },
            });
            return symbol;
          } catch (e) {
            console.error(`[token-sync] failed to update ${symbol}:`, e);
            return null;
          }
        }),
      );
      for (const r of results) if (r) succeeded.push(r);
    }

    updated = succeeded.length;
    failed = toUpdate.length - updated;
    if (succeeded.length > 0) {
      await redis.del(...succeeded.map((s) => `token_meta:${s}`)).catch(() => {});
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
