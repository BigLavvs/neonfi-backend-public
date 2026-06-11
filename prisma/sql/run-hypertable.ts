// Neonfi backend — TimescaleDB hypertable conversion runner.
//
// Runs prisma/sql/001_timescaledb_hypertable.sql on the Neon DIRECT_URL. Invoked
// via `npm run db:hypertable` after `prisma migrate deploy`.
//
// SINGLETON EXCEPTION (Build Guide §3.4): this is a one-shot CLI tool that MUST
// use the DIRECT (non-pooled) connection — the shared lib/prisma.ts singleton is
// bound to the pooled DATABASE_URL and is therefore the wrong client here. This
// dedicated client lives in prisma/ (outside src/, not a request-path client),
// so it does not violate the "one shared client per process" runtime rule.

import { PrismaClient } from '@prisma/client';
import { config } from '../../src/lib/config.js';

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.DIRECT_URL } },
  });

  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS timescaledb;');
    // create_hypertable returns a row → use queryRawUnsafe.
    await prisma.$queryRawUnsafe(
      // Physical column is camelCase "snapshotDate" — Prisma @@maps only table
      // names; the docx's 'snapshot_date' spelling does not exist as a column.
      // Cast to text: Prisma cannot deserialize the composite record type that
      // create_hypertable returns, so we stringify it before it crosses the wire.
      "SELECT create_hypertable('balance_snapshot', 'snapshotDate', if_not_exists => TRUE)::text;",
    );
    // eslint-disable-next-line no-console
    console.log('[hypertable] balance_snapshot converted (or already a hypertable).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[hypertable] failed:', e);
  process.exit(1);
});
