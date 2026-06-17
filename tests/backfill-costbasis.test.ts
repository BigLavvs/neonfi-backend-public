// Neonfi backend — avg-cost backfill script tests (retrofit-38).
//
// Real DB + Redis, per-test truncation. Simulates the pre-retrofit-27 state by seeding an
// asset with avgCost=null / costBasis=0 directly, plus real priced `buy` transactions (which
// would normally trigger recalc, but here are inserted straight to the DB so the null state
// is preserved). The backfill must then recompute the weighted avgCost + costBasis from that
// history, while a cost-less opening lot stays untracked (avgCost=null).

import { it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAllUserData } from './helpers.js';
import { runCostBasisBackfill } from '../src/scripts/backfill-costbasis.js';

// Email mock — registration paths aren't exercised, but app/module graph may pull it in.
vi.mock('../src/modules/email/email.service.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

let btcId: number;
let ethId: number;
let nativeTypeId: number;
let buyDirId: number;

async function seedUser(email: string): Promise<number> {
  const [authProvider, onboarding] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
  ]);
  const u = await prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: 'Backfill User',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  return u.id;
}

async function seedManualPortfolio(userId: number): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'manual' } });
  const p = await prisma.portfolio.create({ data: { userId, name: 'Main', typeId: type.id } });
  return p.id;
}

// Insert a `buy` transaction + native detail DIRECTLY (bypasses the recalc the API would run),
// so the seeded asset keeps its null avgCost — exactly the pre-retrofit-27 shape.
async function seedNativeBuy(
  portfolioId: number,
  symbol: string,
  amount: string,
  usdValue: string,
  timestamp: Date,
): Promise<void> {
  await prisma.transaction.create({
    data: {
      portfolioId,
      typeId: nativeTypeId,
      directionId: buyDirId,
      timestamp,
      nativeDetail: { create: { amount, symbol, usdValue } },
    },
  });
}

beforeAll(async () => {
  const [btc, eth, nativeType, buyDir] = await Promise.all([
    prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } }),
    prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } }),
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } }),
  ]);
  btcId = btc.id;
  ethId = eth.id;
  nativeTypeId = nativeType.id;
  buyDirId = buyDir.id;
});

beforeEach(async () => {
  await truncateAllUserData();
});

it('r38a: backfills weighted avgCost + costBasis from priced buys on an untracked asset', async () => {
  const userId = await seedUser('backfill.a@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);

  // Pre-retrofit-27 shape: asset with null avgCost / 0 costBasis, no opening lot.
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, balance: '0' } });
  // Two real priced buys totalling 0.5 BTC for $32,000 → weighted avg $64,000.
  await seedNativeBuy(portfolioId, 'BTC', '0.3', '20000', new Date('2026-01-01T00:00:00Z'));
  await seedNativeBuy(portfolioId, 'BTC', '0.2', '12000', new Date('2026-02-01T00:00:00Z'));

  // Precondition: still untracked before the backfill.
  const before = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  expect(before.avgCost).toBeNull();
  expect(Number(before.costBasis.toString())).toBe(0);

  const result = await runCostBasisBackfill();
  expect(result.assets).toBe(1);
  expect(result.portfolios).toBe(1);

  const after = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  expect(Number(after.avgCost!.toString())).toBeCloseTo(64000, 2);
  expect(Number(after.costBasis.toString())).toBeCloseTo(32000, 2);
  expect(Number(after.balance.toString())).toBeCloseTo(0.5, 8);
  expect(Number(after.netDeposit.toString())).toBeCloseTo(32000, 2);
});

it('r38b: a cost-less opening lot (null openingCostBasis, no buys) stays avgCost=null', async () => {
  const userId = await seedUser('backfill.b@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);

  // "Don't track cost" opening lot: 10 ETH, no cost basis, no buys.
  await prisma.asset.create({
    data: {
      portfolioId,
      tokenId: ethId,
      balance: '10',
      openingBalance: '10',
      openingCostBasis: null,
    },
  });

  await runCostBasisBackfill();

  const after = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: ethId } },
  });
  expect(after.avgCost).toBeNull(); // correctly stays untracked
  expect(Number(after.costBasis.toString())).toBe(0);
  expect(Number(after.balance.toString())).toBeCloseTo(10, 8);
});

it('r38c: is idempotent — a second run produces the same columns', async () => {
  const userId = await seedUser('backfill.c@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, balance: '0' } });
  await seedNativeBuy(portfolioId, 'BTC', '1', '50000', new Date('2026-01-01T00:00:00Z'));

  await runCostBasisBackfill();
  const first = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  await runCostBasisBackfill();
  const second = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });

  expect(second.avgCost!.toString()).toBe(first.avgCost!.toString());
  expect(second.costBasis.toString()).toBe(first.costBasis.toString());
  expect(second.balance.toString()).toBe(first.balance.toString());
});

it('r38d: --dry-run computes but writes nothing', async () => {
  const userId = await seedUser('backfill.d@neonfi.test');
  const portfolioId = await seedManualPortfolio(userId);
  await prisma.asset.create({ data: { portfolioId, tokenId: btcId, balance: '0' } });
  await seedNativeBuy(portfolioId, 'BTC', '1', '50000', new Date('2026-01-01T00:00:00Z'));

  const result = await runCostBasisBackfill({ dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.assets).toBe(1);

  // Nothing persisted — asset is still in its untracked pre-backfill state.
  const after = await prisma.asset.findUniqueOrThrow({
    where: { portfolioId_tokenId: { portfolioId, tokenId: btcId } },
  });
  expect(after.avgCost).toBeNull();
  expect(Number(after.costBasis.toString())).toBe(0);
});
