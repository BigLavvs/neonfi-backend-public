import type { Token, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export async function findManyTokens(opts: {
  cursor: number | null;
  limit: number;
  search?: string;
  freeTier: boolean;
}): Promise<Token[]> {
  const where: Prisma.TokenWhereInput = {
    id: { gt: opts.cursor ?? 0 },
  };

  if (opts.freeTier) {
    where.rank = { lte: 10 };
  }

  if (opts.search) {
    where.OR = [
      { name:   { contains: opts.search, mode: 'insensitive' } },
      { symbol: { contains: opts.search, mode: 'insensitive' } },
    ];
  }

  return prisma.token.findMany({
    where,
    orderBy: { id: 'asc' },
    take: opts.limit + 1,
  });
}

export async function findTokenById(id: number): Promise<Token | null> {
  return prisma.token.findUnique({ where: { id } });
}

// retrofit-21: price-history rows for one token within the look-back window, oldest
// first (the chart plots left→right). Decimal price is converted to number here so the
// service stays Decimal-free, matching how the token DTOs surface currentPrice.
export async function findTokenPriceSnapshotsSince(
  tokenId: number,
  since: Date,
): Promise<Array<{ snapshotDate: Date; price: number }>> {
  const rows = await prisma.tokenPriceSnapshot.findMany({
    where: { tokenId, snapshotDate: { gte: since } },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, price: true },
  });
  return rows.map((r) => ({ snapshotDate: r.snapshotDate, price: Number(r.price.toString()) }));
}

// retrofit-27: nearest price snapshot ON OR BEFORE `date` (the most recent daily close at
// or before the opening-balance as-of date). Powers the `historical` opening-cost mode;
// null when the token has no snapshot that old, so the caller can 400 PRICE_HISTORY_UNAVAILABLE.
export async function findTokenPriceSnapshotOnOrBefore(
  tokenId: number,
  date: Date,
): Promise<{ snapshotDate: Date; price: number } | null> {
  const row = await prisma.tokenPriceSnapshot.findFirst({
    where: { tokenId, snapshotDate: { lte: date } },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true, price: true },
  });
  return row ? { snapshotDate: row.snapshotDate, price: Number(row.price.toString()) } : null;
}

// retrofit-21: min/max snapshot price over ALL of a token's history (not windowed) —
// the "high/low since tracking began" feeding ATH/ATL. Null when no snapshots exist yet.
export async function aggregateTokenPriceExtremes(
  tokenId: number,
): Promise<{ min: number | null; max: number | null }> {
  const agg = await prisma.tokenPriceSnapshot.aggregate({
    where: { tokenId },
    _min: { price: true },
    _max: { price: true },
  });
  return {
    min: agg._min.price != null ? Number(agg._min.price.toString()) : null,
    max: agg._max.price != null ? Number(agg._max.price.toString()) : null,
  };
}
