import type { Logger } from 'pino';
import type { Actor } from '../../domain/auth/roles';
import {
  decideRefund,
  isOpenPayment,
  type RefundDecision,
} from '../../domain/payments/paymentRules';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type { BookingRepository } from '../../repositories/BookingRepository';
import type { PaymentRepository } from '../../repositories/PaymentRepository';
import { AppError, NotFoundError } from '../../shared/errors/AppError';
import type { BookingLifecycle } from '../booking/BookingLifecycle';
import type { BookingDto, BookingService } from '../booking/BookingService';
import type { PaymentService } from './PaymentService';
import type { RefundService } from './RefundService';

export interface CancellationPreview extends RefundDecision {
  bookingStatus: string;
  paidAmountMinor: number;
  currency: string;
  cancellable: boolean;
}

/**
 * Customer cancellation (PRD §3.11):
 * - HELD / PENDING_PAYMENT: cancelled, seats released, nothing was charged;
 *   an open payment attempt is verified first so a completed payment is never lost.
 * - CONFIRMED: cancelled and seats released; full refund only when the event
 *   starts MORE than 24 hours later, otherwise no refund.
 * The status change, seat release, history and refund record are one transaction;
 * the provider refund call happens after commit and is retried until it settles.
 */
export class CancellationService {
  constructor(
    private readonly db: TransactionRunner & Queryable,
    private readonly bookings: BookingRepository,
    private readonly payments: PaymentRepository,
    private readonly bookingService: BookingService,
    private readonly lifecycle: BookingLifecycle,
    private readonly paymentService: PaymentService,
    private readonly refunds: RefundService,
    private readonly options: { now?: () => Date; logger?: Logger } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async preview(actor: Actor, bookingId: string): Promise<CancellationPreview> {
    const booking = await this.loadOwned(actor, bookingId);
    const startAt = await this.bookings.findEventStart(this.db, bookingId);
    if (!startAt) throw new NotFoundError('Booking not found');
    const paid =
      booking.status === 'CONFIRMED'
        ? await this.payments.findSucceededForBooking(bookingId)
        : null;
    const decision = decideRefund({
      eventStartAt: startAt,
      now: this.now(),
      paidAmountMinor: paid?.amountMinor ?? 0,
    });
    return {
      ...decision,
      bookingStatus: booking.status,
      paidAmountMinor: paid?.amountMinor ?? 0,
      currency: booking.currency,
      cancellable: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status),
    };
  }

  async cancel(
    actor: Actor,
    bookingId: string,
    reason?: string,
  ): Promise<{ booking: BookingDto; refund: RefundDecision }> {
    await this.loadOwned(actor, bookingId);

    // Resolve any open payment attempt with the provider before cancelling.
    const open = await this.payments.findOpenForBooking(bookingId);
    if (open) await this.paymentService.verifyAndApply(open.id);

    const now = this.now();
    const result = await this.db.withTransaction(async (tx) => {
      const booking = await this.bookingService.lockOwned(tx, actor, bookingId);
      const startAt = await this.bookings.findEventStart(tx, bookingId);
      if (!startAt) throw new NotFoundError('Booking not found');

      if (booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT') {
        if (await this.bookingService.expireIfDue(tx, booking)) {
          return {
            decision: { refundable: false, refundAmountMinor: 0, hoursUntilEvent: 0 },
            refundId: null,
          };
        }
        await this.lifecycle.transition(tx, booking, 'CANCELLED', {
          reason: 'cancelled by customer',
          actorId: actor.id,
          cancellationReason: reason ?? 'Cancelled by customer before payment',
        });
        const stillOpen = await this.payments.findOpenForBooking(bookingId, tx);
        if (stillOpen && isOpenPayment(stillOpen.status)) {
          await this.payments.update(tx, stillOpen.id, {
            status: 'CANCELLED',
            failureReason: 'Booking cancelled',
          });
        }
        return {
          decision: decideRefund({ eventStartAt: startAt, now, paidAmountMinor: 0 }),
          refundId: null,
        };
      }

      if (booking.status !== 'CONFIRMED') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Booking is already ${booking.status.toLowerCase()}`,
        );
      }

      const paid = await this.payments.findSucceededForBooking(bookingId, tx);
      const decision = decideRefund({
        eventStartAt: startAt,
        now,
        paidAmountMinor: paid?.amountMinor ?? 0,
      });
      await this.lifecycle.transition(tx, booking, 'CANCELLED', {
        reason: decision.refundable
          ? 'cancelled by customer (full refund)'
          : 'cancelled by customer (no refund)',
        actorId: actor.id,
        details: { refundable: decision.refundable, refundAmountMinor: decision.refundAmountMinor },
        cancellationReason:
          reason ??
          (decision.refundable
            ? 'Cancelled more than 24 hours before the event'
            : 'Cancelled within 24 hours of the event'),
      });
      let refundId: string | null = null;
      if (decision.refundable && paid) {
        const refund = await this.refunds.createWithin(tx, paid, {
          amountMinor: decision.refundAmountMinor,
          reason: 'Customer cancellation more than 24 hours before the event',
        });
        refundId = refund.id;
      }
      return { decision, refundId };
    });

    await this.bookingService.releaseLocksOf(bookingId);
    if (result.refundId) {
      try {
        await this.refunds.process(result.refundId);
      } catch (error) {
        this.options.logger?.error(
          { err: error, bookingId },
          'Refund call failed; the worker will retry',
        );
      }
    }
    return { booking: await this.bookingService.view(bookingId), refund: result.decision };
  }

  /** Customer-triggered retry of a failed refund. */
  async retryRefund(actor: Actor, bookingId: string): Promise<BookingDto> {
    await this.loadOwned(actor, bookingId);
    const refunds = await this.payments.refundsForBooking(bookingId);
    const latest = refunds.at(-1);
    if (!latest || latest.status !== 'FAILED') {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', 'There is no failed refund to retry');
    }
    await this.refunds.retry(latest.paymentId);
    return this.bookingService.view(bookingId);
  }

  private async loadOwned(actor: Actor, bookingId: string) {
    const booking = await this.bookings.findCore(this.db, bookingId);
    if (!booking || (actor.role !== 'ADMIN' && booking.customerId !== actor.id)) {
      throw new NotFoundError('Booking not found');
    }
    return booking;
  }
}
