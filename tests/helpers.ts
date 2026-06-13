// Neonfi backend — shared test helpers (Stages 2+).
//
// Pure utilities that are needed across multiple test files. HTTP helpers
// (post/get/del/patch) live per-file because their BASE URL differs.

import type { Payment } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';

export function cookieValue(res: Response, name: string): string | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function cookieMaxAge(res: Response, name: string): number | undefined {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const header of setCookies) {
    if (!header.startsWith(`${name}=`)) continue;
    const m = /Max-Age=(\d+)/i.exec(header);
    return m ? parseInt(m[1]!, 10) : undefined;
  }
  return undefined;
}

export async function seedPayment(opts: {
  userId: number;
  subscriptionId: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amount?: number;
  refundAvailable?: boolean;
  createdAt?: Date;
}): Promise<Payment> {
  const statusRow = await prisma.paymentStatus.findUniqueOrThrow({ where: { name: opts.status } });
  return prisma.payment.create({
    data: {
      userId: opts.userId,
      subscriptionId: opts.subscriptionId,
      stripePaymentIntentId: `pi_test_${Math.random().toString(36).slice(2)}`,
      amount: opts.amount ?? 2000,
      currency: 'usd',
      statusId: statusRow.id,
      refundAvailable: opts.refundAvailable ?? (opts.status === 'succeeded'),
      ...(opts.createdAt && { createdAt: opts.createdAt }),
    },
  });
}

// Truncates all user-data tables in FK-safe order via CASCADE.
// Faster than chained deleteMany, handles FK order automatically, and resets
// identity sequences so tests don't accumulate row counts across runs.
// Lookup tables (auth_provider, plan, chain, token, etc.) are NOT touched.
export async function truncateAllUserData(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE
    "payment", "subscription", "transaction",
    "nft", "asset", "portfolio",
    "session", "user"
    CASCADE`;
}

export async function clearRedisAuthKeys(): Promise<void> {
  const patterns = [
    'email_verify:*',
    'lockout:login:*',
    'resend_verify:*',
    'ws_ticket:*',
    'oauth_state:*',
  ];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(keys);
  }
}
