import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Actor } from '../../domain/auth/roles';
import {
  ProviderRejectedError,
  ProviderUncertainError,
  type PaymentGatewayRegistry,
  type PaymentProviderName,
  type VerifyPaymentResult,
} from '../../domain/payments/PaymentGateway';
import { canTransitionPayment, isOpenPayment } from '../../domain/payments/paymentRules';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type { BookingRepository } from '../../repositories/BookingRepository';
import type {
  PaymentRecord,
  PaymentRepository,
  RefundRecord,
} from '../../repositories/PaymentRepository';
import type { UserRepository } from '../../repositories/UserRepository';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { BookingLifecycle } from '../booking/BookingLifecycle';
import type { BookingDto, BookingService } from '../booking/BookingService';
import type { SeatLockCoordinator } from '../booking/SeatLockCoordinator';
import type { IdempotencyService } from './IdempotencyService';
import type { RefundService } from './RefundService';

export interface PaymentDto {
  id: string;
  bookingId: string;
  provider: PaymentProviderName;
  status: PaymentRecord['status'];
  amountMinor: number;
  currency: string;
  transactionRef: string;
  /** Where to send the customer for hosted checkouts (only while the attempt is open). */
  redirectUrl: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export function toPaymentDto(payment: PaymentRecord): PaymentDto {
  const redirect = payment.metadata.redirectUrl;
  return {
    id: payment.id,
    bookingId: payment.bookingId,
    provider: payment.provider,
    status: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    transactionRef: payment.transactionRef,
    redirectUrl: isOpenPayment(payment.status) && typeof redirect === 'string' ? redirect : null,
    failureReason: payment.failureReason,
    paidAt: payment.paidAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
  };
}

export interface InitiatePaymentRequest {
  provider: PaymentProviderName;
  paymentMethodToken?: string;
}

export interface PaymentServiceOptions {
  holdExtensionSeconds: number;
  logger?: Logger;
  /** Open attempts older than this are considered abandoned and closed (if the provider agrees). */
  abandonAfterSeconds?: number;
  /** Test card tokens accepted by Mock Provider B (shown in the UI). */
  mockProviderBTokens?: readonly string[];
}

type ApplyEffect = { confirmed: boolean; refundId: string | null };

/**
 * Payment orchestration. Rules:
 * - Amounts always come from the booking total stored on the server.
 * - A booking is confirmed only after the provider confirms the payment through
 *   a server-side verification call whose amount and currency match.
 * - Browser redirects and webhook bodies are only triggers for verification.
 * - Each attempt has a unique transaction ref that providers use as their
 *   idempotency key, so retries and uncertain outcomes can never double charge.
 */
export class PaymentService {
  constructor(
    private readonly db: TransactionRunner & Queryable,
    private readonly payments: PaymentRepository,
    private readonly bookings: BookingRepository,
    private readonly bookingService: BookingService,
    private readonly lifecycle: BookingLifecycle,
    private readonly users: UserRepository,
    private readonly gateways: PaymentGatewayRegistry,
    private readonly idempotency: IdempotencyService,
    private readonly refunds: RefundService,
    private readonly seatLocks: SeatLockCoordinator,
    private readonly options: PaymentServiceOptions,
  ) {}

  enabledProviders(): PaymentProviderName[] {
    return this.gateways.enabled();
  }

  mockProviderBTokens(): readonly string[] {
    return this.gateways.has('MOCK_PROVIDER_B') ? (this.options.mockProviderBTokens ?? []) : [];
  }

  /** POST /bookings/:id/payments with a mandatory Idempotency-Key. */
  async initiate(
    actor: Actor,
    bookingId: string,
    request: InitiatePaymentRequest,
    idempotencyKey: string,
  ): Promise<{ status: number; body: unknown; replayed: boolean }> {
    if (actor.role !== 'CUSTOMER') throw new ForbiddenError('Only customers can pay for bookings');
    if (!this.gateways.has(request.provider)) {
      throw new AppError(
        400,
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `Payment provider ${request.provider} is not available`,
      );
    }
    return this.idempotency.execute(
      {
        userId: actor.id,
        endpoint: 'POST /api/bookings/:id/payments',
        key: idempotencyKey,
        payload: {
          bookingId,
          provider: request.provider,
          paymentMethodToken: request.paymentMethodToken ?? null,
        },
      },
      async () => {
        const payment = await this.startAttempt(actor, bookingId, request, idempotencyKey);
        return { status: 201, body: await this.result(payment.id) };
      },
    );
  }

  private async startAttempt(
    actor: Actor,
    bookingId: string,
    request: InitiatePaymentRequest,
    idempotencyKey: string,
  ): Promise<PaymentRecord> {
    // The payment row is the durable anchor for this key: a retry after a crash resumes it.
    const anchorKey = `pay_${createHash('sha256').update(`${actor.id}:${idempotencyKey}`).digest('hex')}`;
    const existing = await this.payments.findByIdempotencyKey(anchorKey);
    if (existing) {
      if (existing.bookingId !== bookingId) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_MISMATCH',
          'This Idempotency-Key belongs to another booking',
        );
      }
      return isOpenPayment(existing.status) ? this.verifyAndApply(existing.id) : existing;
    }

    const created = await this.db.withTransaction(async (tx) => {
      const booking = await this.bookingService.lockOwned(tx, actor, bookingId);
      if (booking.status !== 'HELD' && booking.status !== 'PENDING_PAYMENT') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Booking is ${booking.status.toLowerCase()}`,
        );
      }
      if (await this.bookingService.expireIfDue(tx, booking)) return { expired: true as const };
      const open = await this.payments.findOpenForBooking(booking.id, tx);
      if (open) {
        throw new AppError(
          409,
          'PAYMENT_IN_PROGRESS',
          'Another payment attempt for this booking is still open',
          [{ path: 'paymentId', message: open.id }],
        );
      }
      if (booking.status === 'HELD') {
        await this.lifecycle.transition(tx, booking, 'PENDING_PAYMENT', {
          reason: 'payment initiated',
          actorId: actor.id,
        });
      }
      // Seats stay protected for the whole payment window.
      const holdUntil = await this.bookings.extendHold(
        tx,
        booking.id,
        this.options.holdExtensionSeconds,
      );
      const payment = await this.payments.create(tx, {
        id: randomUUID(),
        bookingId: booking.id,
        provider: request.provider,
        transactionRef: `TF${randomBytes(12).toString('hex')}`,
        amountMinor: booking.totalAmountMinor,
        currency: booking.currency,
        idempotencyKey: anchorKey,
      });
      return { expired: false as const, payment, eventId: booking.eventId, holdUntil };
    });

    if (created.expired) {
      await this.bookingService.releaseLocksOf(bookingId);
      throw new AppError(409, 'HOLD_EXPIRED', 'Your seat hold expired. Please select seats again.');
    }
    const seatIds = await this.bookings.seatIdsOf(this.db, bookingId);
    await this.seatLocks.extendForBooking(created.eventId, seatIds, bookingId, created.holdUntil);

    return this.callProvider(created.payment, actor, request.paymentMethodToken);
  }

  private async callProvider(
    payment: PaymentRecord,
    actor: Actor,
    token?: string,
  ): Promise<PaymentRecord> {
    const gateway = this.gateways.get(payment.provider);
    const user = await this.users.findById(actor.id);
    const view = await this.bookings.getView(this.db, payment.bookingId);
    try {
      const result = await gateway.initiatePayment({
        transactionRef: payment.transactionRef,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        customer: { name: user?.name ?? 'Customer', email: user?.email ?? 'unknown@example.com' },
        description: `TicketFlow: ${view?.event.title ?? 'Event tickets'}`,
        ...(token ? { paymentMethodToken: token } : {}),
      });

      if (result.status === 'REDIRECT') {
        return this.update(payment.id, {
          status: 'PENDING',
          providerPaymentId: result.providerPaymentId ?? null,
          metadata: { ...(result.metadata ?? {}), redirectUrl: result.redirectUrl },
        });
      }
      if (result.status === 'FAILED') {
        return this.update(payment.id, {
          status: 'FAILED',
          providerPaymentId: result.providerPaymentId ?? null,
          failureReason: result.failureReason ?? 'Payment failed',
          metadata: result.metadata ?? {},
        });
      }
      await this.update(payment.id, {
        status: 'PENDING',
        providerPaymentId: result.providerPaymentId ?? null,
        metadata: result.metadata ?? {},
      });
      // A "success" answer is still re-verified server-side before confirming.
      return this.verifyAndApply(payment.id, result.providerPaymentId ?? null);
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        return this.update(payment.id, { status: 'FAILED', failureReason: error.message });
      }
      // Unknown outcome: never retry the charge blindly. Keep the attempt open;
      // verification (status polls, webhooks, reconciliation) resolves it.
      this.options.logger?.warn(
        { err: error, paymentId: payment.id },
        'Payment outcome uncertain; will verify',
      );
      return this.update(payment.id, {
        status: 'PENDING',
        failureReason:
          error instanceof ProviderUncertainError
            ? 'Awaiting provider confirmation'
            : 'Provider error; verifying',
      });
    }
  }

  /** Fetches the provider's server-side truth and applies it. Uncertain answers leave the attempt open. */
  async verifyAndApply(
    paymentId: string,
    providerPaymentId: string | null = null,
  ): Promise<PaymentRecord> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    let verification: VerifyPaymentResult;
    try {
      verification = await this.gateways.get(payment.provider).verifyPayment({
        transactionRef: payment.transactionRef,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        providerPaymentId:
          providerPaymentId ??
          (payment.provider === 'SSLCOMMERZ' ? null : payment.providerPaymentId),
        metadata: payment.metadata,
      });
    } catch (error) {
      this.options.logger?.warn(
        { err: error, paymentId },
        'Payment verification unavailable; keeping attempt open',
      );
      return payment;
    }
    return this.applyVerification(paymentId, verification);
  }

  /**
   * Applies a verified provider result in ONE transaction: payment row and
   * booking row are locked, then payment status, booking confirmation, status
   * history and (for late or duplicate captures) a refund are written together.
   */
  async applyVerification(
    paymentId: string,
    verification: VerifyPaymentResult,
  ): Promise<PaymentRecord> {
    const effect: ApplyEffect = { confirmed: false, refundId: null };
    const saved = await this.db.withTransaction(async (tx) => {
      const payment = await this.payments.findById(paymentId, tx, true);
      if (!payment) throw new NotFoundError('Payment not found');
      const booking = await this.bookings.findForUpdate(tx, payment.bookingId);
      if (!booking) throw new NotFoundError('Booking not found');
      const metadata = verification.metadata ?? {};

      if (verification.status === 'PENDING') {
        if (payment.status === 'INITIATED')
          return this.payments.update(tx, payment.id, { status: 'PENDING', metadata });
        return payment;
      }

      if (verification.status === 'FAILED') {
        if (!isOpenPayment(payment.status)) return payment; // never downgrade a final state
        return this.payments.update(tx, payment.id, {
          status: 'FAILED',
          providerPaymentId: verification.providerPaymentId ?? null,
          failureReason: verification.failureReason ?? 'Payment failed',
          metadata,
        });
      }

      // SUCCEEDED according to the provider.
      if (payment.status === 'SUCCEEDED') {
        await this.confirmIfPossible(tx, payment, booking, effect);
        return payment;
      }
      const amountMatches =
        verification.amountMinor === undefined || verification.amountMinor === payment.amountMinor;
      const currencyMatches =
        verification.currency === undefined || verification.currency === payment.currency;
      if (!amountMatches || !currencyMatches) {
        this.options.logger?.error(
          { paymentId, expected: payment.amountMinor, reported: verification.amountMinor },
          'Verified payment does not match the booking amount/currency',
        );
        if (!isOpenPayment(payment.status)) return payment;
        return this.payments.update(tx, payment.id, {
          status: 'FAILED',
          failureReason: 'Verification mismatch (amount or currency); refer to support',
          metadata: { ...metadata, verificationMismatch: true },
        });
      }

      const otherSuccess = await this.payments.findSucceededForBooking(booking.id, tx);
      if (otherSuccess && otherSuccess.id !== payment.id) {
        // Customer paid twice (e.g. an abandoned attempt completed later): keep one capture, refund this one.
        const updated = await this.payments.update(tx, payment.id, {
          status:
            payment.status === 'INITIATED' || payment.status === 'PENDING'
              ? 'CANCELLED'
              : payment.status,
          failureReason: 'Duplicate capture refunded',
          metadata: { ...metadata, duplicateCapture: true },
        });
        const refund = await this.refunds.createWithin(tx, updated, {
          amountMinor: payment.amountMinor,
          reason: 'Duplicate payment for an already paid booking',
        });
        effect.refundId = refund.id;
        return updated;
      }

      if (!canTransitionPayment(payment.status, 'SUCCEEDED')) return payment;
      const succeeded = await this.payments.update(tx, payment.id, {
        status: 'SUCCEEDED',
        providerPaymentId: verification.providerPaymentId ?? null,
        metadata,
      });
      await this.confirmIfPossible(tx, succeeded, booking, effect);
      return succeeded;
    });

    if (effect.confirmed) await this.bookingService.releaseLocksOf(saved.bookingId);
    if (effect.refundId) await this.processRefundSafely(effect.refundId);
    return saved;
  }

  private async confirmIfPossible(
    tx: Queryable,
    payment: PaymentRecord,
    booking: Awaited<ReturnType<BookingRepository['findForUpdate']>> & object,
    effect: ApplyEffect,
  ): Promise<void> {
    const outcome = await this.bookingService.confirmWithin(tx, booking, {
      reason: `payment verified (${payment.provider})`,
    });
    if (outcome === 'CONFIRMED') {
      effect.confirmed = true;
      return;
    }
    if (outcome === 'ALREADY_CONFIRMED') return;
    // Money arrived after the hold expired or the booking was cancelled: refund in full.
    const refund = await this.refunds.createWithin(tx, payment, {
      amountMinor: payment.amountMinor,
      reason:
        outcome === 'EXPIRED' || booking.status === 'EXPIRED'
          ? 'Payment received after the seat hold expired'
          : 'Payment received for a cancelled booking',
    });
    effect.refundId = refund.id;
  }

  private async processRefundSafely(refundId: string): Promise<RefundRecord | null> {
    try {
      return await this.refunds.process(refundId);
    } catch (error) {
      this.options.logger?.error(
        { err: error, refundId },
        'Automatic refund failed; the worker will retry',
      );
      return null;
    }
  }

  /** GET /payments/:id — returns status, re-verifying open attempts with the provider. */
  async status(
    actor: Actor,
    paymentId: string,
  ): Promise<{ payment: PaymentDto; booking: BookingDto }> {
    const payment = await this.loadOwned(actor, paymentId);
    if (isOpenPayment(payment.status)) await this.verifyAndApply(payment.id);
    return this.result(payment.id);
  }

  /** Abandons an open attempt (e.g. to switch provider). Verifies first so a completed payment is never lost. */
  async cancelAttempt(
    actor: Actor,
    paymentId: string,
  ): Promise<{ payment: PaymentDto; booking: BookingDto }> {
    const owned = await this.loadOwned(actor, paymentId);
    if (!isOpenPayment(owned.status)) return this.result(owned.id);
    const verified = await this.verifyAndApply(owned.id);
    if (isOpenPayment(verified.status)) {
      await this.db.withTransaction(async (tx) => {
        const locked = await this.payments.findById(owned.id, tx, true);
        if (locked && isOpenPayment(locked.status)) {
          await this.payments.update(tx, locked.id, {
            status: 'CANCELLED',
            failureReason: 'Abandoned by customer',
          });
        }
      });
    }
    return this.result(owned.id);
  }

  /** Worker pass: resolves attempts with unknown outcomes and closes abandoned ones. */
  async reconcileOpen(limit = 50, olderThanSeconds = 30): Promise<number> {
    const open = await this.payments.listOpenForReconciliation(olderThanSeconds, limit);
    const abandonMs = (this.options.abandonAfterSeconds ?? 3600) * 1000;
    for (const payment of open) {
      try {
        const verified = await this.verifyAndApply(payment.id);
        if (
          isOpenPayment(verified.status) &&
          Date.now() - verified.createdAt.getTime() > abandonMs
        ) {
          await this.db.withTransaction(async (tx) => {
            const locked = await this.payments.findById(payment.id, tx, true);
            if (locked && isOpenPayment(locked.status)) {
              await this.payments.update(tx, locked.id, {
                status: 'CANCELLED',
                failureReason: 'Abandoned (no confirmation from provider)',
              });
            }
          });
        }
      } catch (error) {
        this.options.logger?.error(
          { err: error, paymentId: payment.id },
          'Payment reconciliation failed',
        );
      }
    }
    return open.length;
  }

  async findByTransactionRef(ref: string): Promise<PaymentRecord | null> {
    return this.payments.findByTransactionRef(ref);
  }

  /** Ownership check through the booking; foreign payments answer 404. */
  async loadOwned(actor: Actor, paymentId: string): Promise<PaymentRecord> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    const booking = await this.bookings.findCore(this.db, payment.bookingId);
    if (!booking || (actor.role !== 'ADMIN' && booking.customerId !== actor.id)) {
      throw new NotFoundError('Payment not found');
    }
    return payment;
  }

  async result(paymentId: string): Promise<{ payment: PaymentDto; booking: BookingDto }> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    return {
      payment: toPaymentDto(payment),
      booking: await this.bookingService.view(payment.bookingId),
    };
  }

  private update(
    id: string,
    update: Parameters<PaymentRepository['update']>[2],
  ): Promise<PaymentRecord> {
    return this.db.withTransaction(async (tx) => {
      const current = await this.payments.findById(id, tx, true);
      if (!current) throw new NotFoundError('Payment not found');
      if (
        current.status === update.status ||
        !canTransitionPayment(current.status, update.status)
      ) {
        // A webhook may already have moved it further; keep the more advanced state.
        return current.status === update.status ? this.payments.update(tx, id, update) : current;
      }
      return this.payments.update(tx, id, update);
    });
  }
}
