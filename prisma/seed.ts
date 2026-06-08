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

  // --- NOT seeded in Part 1 ---
  // `chain`: GATE B — the 15 supported chains and which 3 are free-tier are NOT
  //   enumerated in any doc (Appendix item 1). The user chose "skip for now", so
  //   the chain table is intentionally left EMPTY. /chains and any chainId FK
  //   have no rows behind them until the list is provided. Do NOT invent it.
  // `token`: populated by the Token Metadata Sync job (Stage 9); not hand-seeded
  //   here. Vendor is an open decision (Appendix item 2).

  // eslint-disable-next-line no-console
  console.log('[seed] lookup tables seeded (auth_provider, onboarding_status, plan, billing_cycle, subscription_status, payment_status, portfolio_type, transaction_type). chain + token intentionally empty.');
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
