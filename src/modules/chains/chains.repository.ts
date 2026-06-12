import type { Chain } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export async function listAllChains(): Promise<Chain[]> {
  return prisma.chain.findMany({ orderBy: { id: 'asc' } });
}
