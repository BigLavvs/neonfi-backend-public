import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { PortfolioWithRelations } from './portfolios.dto.js';

const PORTFOLIO_INCLUDE = {
  include: { type: true, chain: true },
} as const satisfies Prisma.PortfolioDefaultArgs;

export async function findPortfolioById(id: number): Promise<PortfolioWithRelations | null> {
  return prisma.portfolio.findUnique({ where: { id }, ...PORTFOLIO_INCLUDE });
}

export async function findPortfoliosByUserId(
  userId: number,
  opts: { limit: number; offset: number; ids?: number[] },
): Promise<{ portfolios: PortfolioWithRelations[]; total: number }> {
  // retrofit-50: an optional id whitelist scopes the read to a subset of the user's
  // portfolios (the overview portfolio filter). Keeping `userId` in the where means a
  // foreign id simply matches nothing — ownership is never bypassed.
  const where: Prisma.PortfolioWhereInput = {
    userId,
    ...(opts.ids ? { id: { in: opts.ids } } : {}),
  };
  const [portfolios, total] = await prisma.$transaction([
    prisma.portfolio.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: opts.limit,
      skip: opts.offset,
      ...PORTFOLIO_INCLUDE,
    }),
    prisma.portfolio.count({ where }),
  ]);
  return { portfolios, total };
}

export async function countPortfoliosByUserId(userId: number): Promise<number> {
  return prisma.portfolio.count({ where: { userId } });
}

// retrofit-88 (Issue 2): does this user already have a CONNECTED portfolio for this EXACT
// wallet+chain? Connecting the same wallet twice double-counts its value in the overview total
// (net worth ~doubles) while the on-chain tx count is deduped to one — an inconsistent, misleading
// aggregate. createPortfolio uses this to 409 before creating the duplicate. Same address on a
// DIFFERENT chain is a genuinely separate holding, so chainId is part of the match.
export async function findConnectedPortfolioByWallet(
  userId: number,
  walletAddress: string,
  chainId: number,
): Promise<{ id: number; name: string } | null> {
  return prisma.portfolio.findFirst({
    where: { userId, chainId, walletAddress, type: { name: 'connected' } },
    select: { id: true, name: true },
  });
}

export async function findUserPortfolioNames(
  userId: number,
): Promise<Array<{ id: number; name: string }>> {
  return prisma.portfolio.findMany({
    where: { userId },
    select: { id: true, name: true },
  });
}

export async function createPortfolioRow(data: {
  userId: number;
  name: string;
  typeId: number;
  walletAddress?: string;
  chainId?: number;
  startingBalance?: string;
  // retrofit-2 §1.5: manual portfolios seed netDeposit from startingBalance;
  // connected portfolios omit it and default to 0 via the schema.
  netDeposit?: string;
}): Promise<PortfolioWithRelations> {
  return prisma.portfolio.create({ data, ...PORTFOLIO_INCLUDE });
}

export async function updatePortfolioName(
  id: number,
  name: string,
): Promise<PortfolioWithRelations> {
  return prisma.portfolio.update({ where: { id }, data: { name }, ...PORTFOLIO_INCLUDE });
}

export async function deletePortfolio(id: number): Promise<void> {
  await prisma.portfolio.delete({ where: { id } });
}
