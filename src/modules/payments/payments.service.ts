import { listPaymentsByUser, findPaymentById } from './payments.repository.js';
import { toPaymentDTO, type PaymentDTO } from './payments.dto.js';
import type { ListPaymentsQuery } from './payments.schemas.js';

export class PaymentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export async function listMyPayments(
  userId: number,
  query: ListPaymentsQuery,
): Promise<{ payments: PaymentDTO[]; meta: { limit: number; offset: number; total: number } }> {
  const { limit, offset, status } = query;
  const { payments, total } = await listPaymentsByUser(userId, { limit, offset, statusName: status });
  return {
    payments: payments.map(toPaymentDTO),
    meta: { limit, offset, total },
  };
}

export async function getPaymentById(
  userId: number,
  paymentId: number,
): Promise<{ payment: PaymentDTO }> {
  const payment = await findPaymentById(paymentId);
  if (!payment || payment.userId !== userId) {
    throw new PaymentError(403, 'FORBIDDEN', 'Payment not found or access denied');
  }
  return { payment: toPaymentDTO(payment) };
}
