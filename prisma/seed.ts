// Neonfi backend — seed (Build Guide §1.4).
//
// Because enums are lookup TABLES, these rows MUST exist or any insert
// referencing them fails. Values are CASE-SENSITIVE, CHARACTER-IDENTICAL to the
// frontend's strings (Divergence Watch §1.4): `cancelled` not `canceled`,
// `connected` not `wallet`, `erc20` not `ERC20`. Do NOT normalize. Each table is
// upserted by its unique `name`, so the seed is idempotent.
//
// Uses the shared Prisma singleton (no `new PrismaClient()` outside lib/, §3.4).

import { prisma } from '../src/lib/prisma.js';
import { CHAINS } from '../src/modules/chains/chains.constants.js';
import { TOKENS } from '../src/modules/tokens/tokens.constants.js';

async function upsertByName(
  model: { upsert: (args: unknown) => Promise<unknown> },
  names: string[],
  extra: (name: string) => Record<string, unknown> = () => ({}),
): Promise<void> {
  for (const name of names) {
    await model.upsert({
      where: { name },
      update: extra(name),
      create: { name, ...extra(name) },
    });
  }
}

async function main(): Promise<void> {
  // 1. auth_provider
  await upsertByName(prisma.authProvider, ['email', 'google']);

  // 2. onboarding_status
  await upsertByName(prisma.onboardingStatus, [
    'pending_verification',
    'verified',
    'plan_selected',
    'complete',
  ]);

  // 3. plan — `pros` / `cons` are String[]; left EMPTY for now.
  // TODO: fill pros/cons from the marketing copy (landing/pricing) before launch.
  await upsertByName(prisma.plan, ['free', 'pro'], () => ({ pros: [], cons: [] }));

  // 4. billing_cycle
  await upsertByName(prisma.billingCycle, ['monthly', 'yearly']);

  // 5. subscription_status
  await upsertByName(prisma.subscriptionStatus, ['active', 'cancelled', 'expired']);

  // 6. payment_status
  await upsertByName(prisma.paymentStatus, ['pending', 'succeeded', 'failed', 'refunded']);

  // 7. portfolio_type
  await upsertByName(prisma.portfolioType, ['connected', 'manual']);

  // 8. transaction_type
  await upsertByName(prisma.transactionType, ['native', 'erc20', 'nft']);

  // 9. transaction_direction
  await upsertByName(prisma.transactionDirection, ['buy', 'sell', 'transfer']);

  // 10. chains — GATE B resolved in Stage 5; list locked by Idowu
  for (const chain of CHAINS) {
    await prisma.chain.upsert({
      where: { slug: chain.slug },
      update: { name: chain.name, moralisId: chain.moralisId, logoUrl: chain.logoUrl },
      create: chain,
    });
  }

  // 11. tokens — 30 popular tokens for dev usability (upsert by symbol)
  for (const token of TOKENS) {
    await prisma.token.upsert({
      where: { symbol: token.symbol },
      update: {
        name: token.name,
        rank: token.rank,
        currentPrice: token.currentPrice,
        marketCap: token.marketCap,
      },
      create: {
        name: token.name,
        symbol: token.symbol,
        rank: token.rank,
        currentPrice: token.currentPrice,
        marketCap: token.marketCap,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log('[seed] lookup tables seeded (auth_provider, onboarding_status, plan, billing_cycle, subscription_status, payment_status, portfolio_type, transaction_type, transaction_direction, chain, token — 30 tokens).');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
