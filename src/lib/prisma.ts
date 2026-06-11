// Neonfi backend — single shared Prisma client (Build Guide §1.1 / §3.4).
//
// The Prisma client is instantiated ONCE per process and imported everywhere.
// NEVER construct `new PrismaClient()` anywhere else — per-request instantiation
// exhausts the Neon connection pool. The global-singleton pattern below survives
// hot-reload in dev (tsx watch) so repeated module evaluation does not spawn
// multiple clients.

import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// When NODE_ENV=test and DATABASE_URL_TEST is set, use the test database so
// integration tests run in isolation from the dev database.
const testDbUrl = config.NODE_ENV === 'test' && config.DATABASE_URL_TEST
  ? config.DATABASE_URL_TEST
  : undefined;

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: testDbUrl ? { db: { url: testDbUrl } } : undefined,
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
