import type { Logger } from 'pino';
import {
  ProviderUncertainError,
  type PaymentGatewayRegistry,
  type RefundPaymentResult,
} from '../../domain/payments/PaymentGateway';
import { refundRetryDelayMs } from '../../domain/payments/paymentRules';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type {
  PaymentRecord,
  PaymentRepository,
  RefundRecord,
} from '../../repositories/PaymentRepository';

export interface RefundDto {
  id: string;
  status: RefundRecord['status'];
  amountMinor: number;
  currency: string;
  attempt: number;
  reason: string | null;
  failureReason: string | null;
  processedAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export function toRefundDto(refund: RefundRecord): RefundDto {
  return {
    id: refund.id,
    status: refund.status,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    attempt: refund.attempt,
    reason: refund.reason,
    failureReason: refund.failureReason,
    processedAt: refund.processedAt?.toISOString() ?? null,
    nextRetryAt: refund.nextRetryAt?.toISOString() ?? null,
    createdAt: refund.createdAt.toISOString(),
  };
}

/**
 * Refund lifecycle: PENDING -> PROCESSING -> SUCCEEDED | FAILED, with retries.
 * - Each attempt is a row with its own idempotency key; re-sending the same
 *   attempt (after a timeout) reuses the key so providers never refund twice.
 * - A definitive failure schedules a new attempt with exponential backoff.
 * - At most one live refund per payment is enforced by a partial unique index.
 * - The booking's refund_amount_minor cache is updated in the same transaction
 *   as the successful refund.
 */
export class RefundService {
  constructor(
    private readonly db: TransactionRunner & Queryable,
    private readonly payments: PaymentRepository,
    private readonly gateways: PaymentGatewayRegistry,
    private readonly options: { maxAttempts: number; logger?: Logger },
  ) {}

  /** Creates the next refund attempt inside the caller's transaction (no provider call). */
  async createWithin(
    tx: Queryable,
    payment: PaymentRecord,
    params: { amountMinor: number; reason: string },
  ): Promise<RefundRecord> {
    const latest = await this.payments.latestRefund(payment.id, tx);
    if (latest && latest.status !== 'FAILED') return latest; // live or already refunded
    const attempt = (latest?.attempt ?? 0) + 1;
    const refund = await this.payments.createRefund(tx, {
      bookingId: payment.bookingId,
      paymentId: payment.id,
      amountMinor: params.amountMinor,
      currency: payment.currency,
      attempt,
      idempotencyKey: `refund_${payment.transactionRef}_${attempt}`,
      reason: params.reason,
    });
    // Safety net: if this process dies before calling the provider, the worker picks it up.
    return this.payments.updateRefund(tx, refund.id, {
      status: 'PENDING',
      nextRetryAt: new Date(Date.now() + 60_000),
    });
  }

  /** Sends (or re-sends with the same key) a refund attempt to the provider and records the result. */
  async process(refundId: string): Promise<RefundRecord> {
    const refund = await this.payments.findRefund(refundId);
    if (!refund) throw new Error(`Refund ${refundId} not found`);
    if (refund.status === 'SUCCEEDED') return refund;
    const payment = await this.payments.findById(refund.paymentId);
    if (!payment) throw new Error(`Payment ${refund.paymentId} not found`);
    const gateway = this.gateways.get(payment.provider);

    let result: RefundPaymentResult;
    try {
      result =
        refund.status === 'PROCESSING' && refund.providerRefundId
          ? await gateway.refundStatus({
              providerRefundId: refund.providerRefundId,
              metadata: payment.metadata,
            })
          : await gateway.refundPayment({
              transactionRef: payment.transactionRef,
              providerPaymentId: payment.providerPaymentId,
              amountMinor: refund.amountMinor,
              currency: refund.currency,
              idempotencyKey: refund.idempotencyKey,
              reason: refund.reason ?? 'Booking cancelled',
              metadata: payment.metadata,
            });
    } catch (error) {
      const uncertain = error instanceof ProviderUncertainError;
      this.options.logger?.warn(
        { err: error, refundId },
        'Refund call failed; will retry with the same key',
      );
      return this.record(refund, {
        status: refund.status === 'PROCESSING' ? 'PROCESSING' : 'PENDING',
        failureReason: uncertain ? 'Provider unreachable; retrying' : (error as Error).message,
        nextRetryAt: new Date(Date.now() + refundRetryDelayMs(refund.attempt)),
      });
    }

    if (result.status === 'SUCCEEDED')
      return this.record(refund, {
        status: 'SUCCEEDED',
        providerRefundId: result.providerRefundId ?? null,
      });
    if (result.status === 'PROCESSING') {
      return this.record(refund, {
        status: 'PROCESSING',
        providerRefundId: result.providerRefundId ?? null,
        nextRetryAt: new Date(Date.now() + 60_000),
      });
    }
    const canRetry = refund.attempt < this.options.maxAttempts;
    return this.record(refund, {
      status: 'FAILED',
      failureReason: result.failureReason ?? 'Refund failed',
      nextRetryAt: canRetry ? new Date(Date.now() + refundRetryDelayMs(refund.attempt)) : null,
    });
  }

  /** Customer- or admin-triggered retry of a failed refund (also used by the worker). */
  async retry(paymentId: string): Promise<RefundRecord | null> {
    const next = await this.db.withTransaction(async (tx) => {
      const payment = await this.payments.findById(paymentId, tx, true);
      if (!payment) return null;
      const latest = await this.payments.latestRefund(paymentId, tx);
      if (!latest) return null;
      if (latest.status !== 'FAILED') return latest;
      if (latest.attempt >= this.options.maxAttempts) return latest;
      return this.createWithin(tx, payment, {
        amountMinor: latest.amountMinor,
        reason: latest.reason ?? 'Retry',
      });
    });
    if (!next || next.status === 'SUCCEEDED' || next.status === 'FAILED') return next;
    return this.process(next.id);
  }

  /** Worker pass: re-send pending attempts, poll processing ones, retry failed ones when due. */
  async processDue(limit = 50): Promise<number> {
    const due = await this.payments.listDueRefunds(limit);
    for (const refund of due) {
      try {
        if (refund.status === 'FAILED') await this.retry(refund.paymentId);
        else await this.process(refund.id);
      } catch (error) {
        this.options.logger?.error({ err: error, refundId: refund.id }, 'Refund retry pass failed');
      }
    }
    return due.length;
  }

  private async record(
    refund: RefundRecord,
    update: {
      status: RefundRecord['status'];
      providerRefundId?: string | null;
      failureReason?: string | null;
      nextRetryAt?: Date | null;
    },
  ): Promise<RefundRecord> {
    return this.db.withTransaction(async (tx) => {
      const current = await this.payments.findRefund(refund.id, tx, true);
      if (!current || current.status === 'SUCCEEDED') return current ?? refund;
      const saved = await this.payments.updateRefund(tx, refund.id, update);
      if (saved.status === 'SUCCEEDED') {
        const refunded = (await this.payments.refundsForBooking(saved.bookingId, tx))
          .filter((r) => r.status === 'SUCCEEDED')
          .reduce((sum, r) => sum + r.amountMinor, 0);
        await this.payments.setBookingRefundAmount(tx, saved.bookingId, refunded);
      }
      return saved;
    });
  }
}
