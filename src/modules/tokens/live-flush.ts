// Neonfi backend — live price → Token.currentPrice flush (retrofit-70 fix #2).
//
// The read-side overlay (retrofit-15/16) prefers the live canonical `price:<SYM>` tick
// over the persisted Token.currentPrice, but currentPrice itself only moves on the
// 6-hourly CMC catalog sync (token-sync.job). So any read that FALLS BACK to currentPrice
// — the overview allocation when a symbol has no fresh tick at read time, the daily
// `token_price_snapshot`, the token-detail pages — can be hours stale, which made the
// dashboard total flip across loads (M20) and the chart's right edge inherit a stale,
// duplicated price (C3/C8).
//
// This short-interval flush writes the canonical live price back into Token.currentPrice
// so the persisted value tracks the feed (within the flush interval) instead of the CMC
// cadence. Tokens with NO fresh tick are left untouched (we never overwrite a known price
// with nothing); unchanged prices are skipped (the `<>` guard) so a quiet market produces
// no write churn. One bulk `UPDATE … FROM (VALUES …)` — a single round-trip over the
// whole catalog, the same shape the snapshot job uses for token_price_snapshot.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getLivePriceMap } from '../../lib/live-price.js';

export async function flushLivePricesToCurrentPrice(): Promise<{ updated: number }> {
  const tokens = await prisma.token.findMany({ select: { id: true, symbol: true } });
  if (tokens.length === 0) return { updated: 0 };

  const liveMap = await getLivePriceMap(tokens.map((t) => t.symbol));
  const rows = tokens
    .map((t) => {
      const live = liveMap.get(t.symbol);
      // No fresh tick → skip (leave currentPrice as-is, never copy a missing price).
      return live === undefined ? null : Prisma.sql`(${t.id}::int, ${live.toString()}::decimal)`;
    })
    .filter((r): r is Prisma.Sql => r !== null);

  if (rows.length === 0) return { updated: 0 };

  // `<> v.price` skips no-op writes so an unchanged price costs nothing. $executeRaw
  // returns the number of rows actually updated.
  const updated = await prisma.$executeRaw`
    UPDATE "token" AS t
    SET "currentPrice" = v.price
    FROM (VALUES ${Prisma.join(rows)}) AS v(id, price)
    WHERE t.id = v.id AND t."currentPrice" <> v.price
  `;
  return { updated };
}
