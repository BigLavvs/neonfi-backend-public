import type { Prisma } from '@prisma/client';

export type PaymentWithStatus = Prisma.PaymentGetPayload<{
  include: { status: true };
}>;

export interface PaymentDTO {
  id: number;
  userId: number | null;
  // retrofit-5: nullable now that Payment.subscriptionId is SetNull (mirrors userId).
  // An orphaned payment kept after account deletion has subscriptionId = null.
  subscriptionId: number | null;
  stripePaymentIntentId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  refundAvailable: boolean;
  createdAt: Date;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export function toPaymentDTO(payment: PaymentWithStatus): PaymentDTO {
  const refundAvailable =
    payment.refundAvailable &&
    payment.status.name === 'succeeded' &&
    Date.now() - payment.createdAt.getTime() <= THREE_DAYS_MS;

  return {
    id: payment.id,
    userId: payment.userId,
    subscriptionId: payment.subscriptionId,
    stripePaymentIntentId: payment.stripePaymentIntentId,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status.name as PaymentDTO['status'],
    refundAvailable,
    createdAt: payment.createdAt,
  };
}
