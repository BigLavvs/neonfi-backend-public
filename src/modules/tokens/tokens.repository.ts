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
