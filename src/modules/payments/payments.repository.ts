import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { PaymentWithStatus } from './payments.dto.js';

const PAYMENT_INCLUDE = {
  include: { status: true },
} as const satisfies Prisma.PaymentDefaultArgs;

export async function listPaymentsByUser(
  userId: number,
  opts: { limit: number; offset: number; statusName?: string },
): Promise<{ payments: PaymentWithStatus[]; total: number }> {
  const where: Prisma.PaymentWhereInput = {
    userId,
    ...(opts.statusName && { status: { name: opts.statusName } }),
  };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
      ...PAYMENT_INCLUDE,
    }),
    prisma.payment.count({ where }),
  ]);

  return { payments, total };
}

export async function findPaymentById(id: number): Promise<PaymentWithStatus | null> {
  return prisma.payment.findUnique({
    where: { id },
    ...PAYMENT_INCLUDE,
  });
}
