// retrofit-41 — one-off, idempotent snapshot-history backfill (dev/demo seed).
//
// Every time-series chart is empty on a fresh/dev DB: snapshot.job.ts only ever
// writes balance_snapshot (Pro-only) and token_price_snapshot GOING FORWARD, one row
// per UTC day. With no history, the dashboard "Portfolio Value" chart, the token-detail
// price charts and the performance charts all show "Not enough history yet". The READ
// paths are NOT plan-gated (overview.service → findAllSnapshotsAscByPortfolio; token
// history → token_price_snapshot), so inserting historical rows makes the charts render
// for any plan.
//
// This seeds ~365 days of PLAUSIBLE DEMO history (a seeded random walk that lands on each
// token's CURRENT real price — clearly synthetic, NOT real historical data; there's no
// historical price source wired in). Two steps:
//   1. Per-token daily price series, walked BACKWARD from Token.currentPrice so the series
//      ENDS at today's real price. Written to token_price_snapshot in chunked bulk inserts
//      mirroring snapshot.job's ON CONFLICT upsert. Powers token charts + feeds step 2.
//   2. Per-portfolio daily value = Σ(current balance × that day's seeded token price), for
//      EVERY portfolio (the read isn't Pro-gated). Written to balance_snapshot the same way.
//      (Simplification: uses CURRENT balances for all past days — fine for a demo curve; it
//      does NOT reconstruct holdings as of each historical date.)
//   3. Invalidate the affected derived caches + per-user overview caches so the next chart
//      load recomputes from the new history.
//
// IDEMPOTENT by construction: a per-tokenId-seeded PRNG reproduces the same curve on every
// run (true value idempotency, not just row counts), and ON CONFLICT DO UPDATE rewrites the
// same rows — re-running yields identical row counts AND identical values.
//
// Ongoing snapshots remain Pro-gated in snapshot.job.ts (write side); this backfill only
// makes the charts render now. Run: `npm run backfill:snapshots`.

import { pathToFileURL } from 'node:url';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { portfolioDerivedCacheKeys } from '../lib/portfolio-cache-keys.js';

export const DAYS = 365;
const DAILY_VOL = 0.025; // ~2.5%/day — plausible crypto volatility
// Bulk-insert chunk size. 3 params/row × 1000 = 3000 bind params/statement, well under
// Postgres' 65535 limit, and keeps each round-trip cheap under Neon's per-query latency.
const CHUNK = 1000;

export interface BackfillSnapshotsResult {
  tokenSeries: number; // catalog tokens that got a price series
  tokenRows: number; // token_price_snapshot rows written (= tokenSeries × DAYS)
  portfolioRows: number; // balance_snapshot rows written (= portfolios × DAYS)
}

// Deterministic PRNG (mulberry32). Seeded per tokenId so every run reproduces the same
// series for a given token → re-running the backfill is truly idempotent (same values,
// not merely the same row count).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Walk BACKWARD from currentPrice so out[DAYS-1] is today's real price and the series
// drifts plausibly before it. index 0 = oldest day, DAYS-1 = today.
export function seriesFor(currentPrice: number, tokenId: number): number[] {
  const rng = mulberry32(tokenId);
  const out = new Array<number>(DAYS);
  out[DAYS - 1] = currentPrice; // today = real price
  for (let i = DAYS - 2; i >= 0; i--) {
    const r = (rng() * 2 - 1) * DAILY_VOL; // ±vol
    out[i] = Math.max(1e-8, out[i + 1]! * (1 - r)); // step backward, never ≤ 0
  }
  return out;
}

// 'YYYY-MM-DD' (UTC) for `today − offset` days. The columns are @db.Date, so we pin each
// row to an unambiguous calendar day regardless of server timezone — and the same string
// re-targets the same row on a re-run (composite-PK upsert).
function dateStringForOffset(todayMidnightUtcMs: number, offsetDays: number): string {
  return new Date(todayMidnightUtcMs - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// price/value → fixed 8dp string (the columns are Decimal(20,8)). toFixed avoids scientific
// notation (e.g. a 1e-8 floor would serialize as "1e-8" and break the ::decimal cast).
function dec8(n: number): string {
  return n.toFixed(8);
}

async function bulkUpsert(
  table: 'token_price_snapshot' | 'balance_snapshot',
  conflictCols: string,
  rows: Prisma.Sql[],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    if (table === 'token_price_snapshot') {
      written += await prisma.$executeRaw`
        INSERT INTO "token_price_snapshot" ("tokenId", "price", "snapshotDate")
        VALUES ${Prisma.join(chunk)}
        ON CONFLICT (${Prisma.raw(conflictCols)}) DO UPDATE SET "price" = EXCLUDED."price"
      `;
    } else {
      written += await prisma.$executeRaw`
        INSERT INTO "balance_snapshot" ("portfolioId", "userId", "value", "snapshotDate")
        VALUES ${Prisma.join(chunk)}
        ON CONFLICT (${Prisma.raw(conflictCols)}) DO UPDATE SET "value" = EXCLUDED."value"
      `;
    }
  }
  return written;
}

export async function runSnapshotsBackfill(): Promise<BackfillSnapshotsResult> {
  // Anchor every date to today's UTC midnight; reuse the ms across both steps.
  const todayMidnightUtcMs = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  // Precompute the date string for each series index once (shared by both tables).
  // index i → date = today − (DAYS-1-i) days, so ymdByIndex[DAYS-1] === today.
  const ymdByIndex = new Array<string>(DAYS);
  for (let i = 0; i < DAYS; i++) ymdByIndex[i] = dateStringForOffset(todayMidnightUtcMs, DAYS - 1 - i);

  // ----- Step 1: per-token daily price series -----------------------------------------
  const tokens = await prisma.token.findMany({ select: { id: true, currentPrice: true } });
  const priceByToken = new Map<number, number[]>();
  const tokenRowSql: Prisma.Sql[] = [];
  for (const t of tokens) {
    const series = seriesFor(Number(t.currentPrice.toString()), t.id);
    priceByToken.set(t.id, series);
    for (let i = 0; i < DAYS; i++) {
      // Today's row uses the exact stored Decimal string so the series provably ends on the
      // real current price; earlier days use the seeded walk formatted to 8dp.
      const priceStr = i === DAYS - 1 ? t.currentPrice.toString() : dec8(series[i]!);
      tokenRowSql.push(Prisma.sql`(${t.id}::int, ${priceStr}::decimal, ${ymdByIndex[i]!}::date)`);
    }
  }
  const tokenRows = await bulkUpsert('token_price_snapshot', '"tokenId", "snapshotDate"', tokenRowSql);

  // ----- Step 2: per-portfolio daily value --------------------------------------------
  const portfolios = await prisma.portfolio.findMany({
    select: { id: true, userId: true, assets: { select: { tokenId: true, balance: true } } },
  });
  const balanceRowSql: Prisma.Sql[] = [];
  for (const p of portfolios) {
    const holdings = p.assets.map((a) => ({
      balance: Number(a.balance.toString()),
      series: priceByToken.get(a.tokenId),
    }));
    for (let i = 0; i < DAYS; i++) {
      let value = 0;
      for (const h of holdings) if (h.series) value += h.balance * h.series[i]!;
      balanceRowSql.push(
        Prisma.sql`(${p.id}::int, ${p.userId}::int, ${dec8(value)}::decimal, ${ymdByIndex[i]!}::date)`,
      );
    }
  }
  const portfolioRows = await bulkUpsert('balance_snapshot', '"portfolioId", "snapshotDate"', balanceRowSql);

  // ----- Step 3: invalidate read caches so the next chart load recomputes -------------
  // Best-effort: a Redis hiccup must not undo a successful backfill. Two layers, mirroring
  // prices.service.invalidateUserReadCaches: the per-portfolio derived caches (portfolio_pnl
  // + analytics_*) and the per-user overview response cache (every days/txLimit variant).
  try {
    const derivedKeys = portfolios.flatMap((p) => portfolioDerivedCacheKeys(p.id));
    if (derivedKeys.length > 0) await redis.del(...derivedKeys);
    const userIds = [...new Set(portfolios.map((p) => p.userId))];
    for (const uid of userIds) {
      const overviewKeys = await redis.keys(`overview:${uid}:*`);
      if (overviewKeys.length > 0) await redis.del(...overviewKeys);
    }
  } catch (e) {
    console.error('[backfill:snapshots] cache invalidation failed (non-fatal):', (e as Error).message);
  }

  const result: BackfillSnapshotsResult = { tokenSeries: tokens.length, tokenRows, portfolioRows };
  console.log(JSON.stringify({ event: 'snapshots_backfill_done', ...result }));
  return result;
}

// CLI entry (mirrors backfill-costbasis.ts). Only runs when invoked directly, NOT when
// imported by a test — pathToFileURL(argv[1]) is the cross-platform ESM main-module check
// (handles Windows `file:///C:/…`).
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runSnapshotsBackfill()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[backfill:snapshots] failed:', e);
      process.exit(1);
    });
}
