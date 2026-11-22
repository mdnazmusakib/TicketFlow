import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Actor } from '../../domain/auth/roles';
import type { BookingStatus } from '../../domain/lifecycle/bookingStateMachine';
import type { PricingStrategyRegistry } from '../../domain/pricing/PricingStrategy';
import { buildQuote, type Quote } from '../../domain/pricing/quote';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type { Lock } from '../../infrastructure/redis/LockManager';
import type {
  BookableEvent,
  BookingCore,
  BookingRepository,
  BookingView,
} from '../../repositories/BookingRepository';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { buildPaginationMeta } from '../../shared/http/apiResponse';
import type { BookingExpiryService, ExpiredBooking } from './BookingExpiryService';
import type { BookingLifecycle } from './BookingLifecycle';
import type { SeatLockCoordinator } from './SeatLockCoordinator';

export interface BookingServiceOptions {
  maxTicketsPerUserPerEvent: number;
  holdTtlSeconds: number;
  logger?: Logger;
  now?: () => Date;
}

export interface HoldInput {
  eventId: string;
  seatIds: string[];
  idempotencyKey?: string;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function toBookingDto(view: BookingView, now: Date = new Date()) {
  return {
    id: view.id,
    status: view.status,
    eventId: view.eventId,
    event: {
      title: view.event.title,
      startAt: view.event.startAt.toISOString(),
      venueName: view.event.venueName,
      venueCity: view.event.venueCity,
      timezone: view.event.timezone,
    },
    holdExpiresAt:
      view.status === 'HELD' || view.status === 'PENDING_PAYMENT' ? iso(view.holdExpiresAt) : null,
    pricingStrategy: view.pricingStrategy,
    totalAmountMinor: view.totalAmountMinor,
    refundAmountMinor: view.refundAmountMinor,
    currency: view.currency,
    seats: view.seats.map((seat) => ({
      seatId: seat.seatId,
      row: seat.rowLabel,
      number: seat.seatNumber,
      category: seat.categoryName,
      priceMinor: seat.priceMinor,
      state: seat.seatState,
    })),
    history: view.history.map((entry) => ({
      from: entry.fromStatus,
      to: entry.toStatus,
      reason: entry.reason,
      at: entry.changedAt.toISOString(),
    })),
    confirmedAt: iso(view.confirmedAt),
    cancelledAt: iso(view.cancelledAt),
    expiredAt: iso(view.expiredAt),
    createdAt: view.createdAt.toISOString(),
    /** Lets clients correct their clock when rendering the countdown. */
    serverTime: now.toISOString(),
  };
}

export type BookingDto = ReturnType<typeof toBookingDto>;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}

function quoteDto(quote: Quote, unavailableSeatIds: string[]) {
  return {
    currency: quote.currency,
    appliedStrategy: quote.appliedStrategy,
    subtotalMinor: quote.subtotalMinor,
    discountMinor: quote.discountMinor,
    totalMinor: quote.totalMinor,
    lines: quote.lines.map((line) => ({
      seatId: line.seatId,
      row: line.rowLabel,
      number: line.seatNumber,
      category: line.categoryName,
      basePriceMinor: line.basePriceMinor,
      discountMinor: line.discountMinor,
      unitPriceMinor: line.unitPriceMinor,
      available: !unavailableSeatIds.includes(line.seatId),
    })),
  };
}

/**
 * Customer booking flows. Correctness rules (DATABASE_DESIGN.md §5):
 * - Redis locks only pre-filter contention; PostgreSQL decides.
 * - Each hold runs in ONE transaction: event row FOR SHARE, stale holds expired,
 *   per-(customer, event) advisory lock, ticket-limit count, inserts guarded by
 *   idx_active_seat_per_event, history row.
 * - Any failure rolls back and releases only the locks this request owns.
 */
export class BookingService {
  constructor(
    private readonly db: TransactionRunner & Queryable,
    private readonly bookings: BookingRepository,
    private readonly lifecycle: BookingLifecycle,
    private readonly expiry: BookingExpiryService,
    private readonly seatLocks: SeatLockCoordinator,
    private readonly pricing: PricingStrategyRegistry,
    private readonly options: BookingServiceOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Server-side price preview for a seat selection (no reservation). */
  async quote(eventId: string, seatIds: string[]) {
    const unique = this.normalizeSeats(seatIds);
    const event = await this.db.withTransaction((tx) =>
      this.bookings.lockEventForBooking(tx, eventId),
    );
    this.assertOnSale(event);
    const seats = await this.bookings.findSeatsForPricing(this.db, eventId, unique);
    if (seats.length !== unique.length)
      throw new NotFoundError('One or more seats were not found in this event');
    const unavailable = await this.bookings.findUnavailableSeatIds(this.db, unique);
    return quoteDto(buildQuote(this.pricing, event, seats, this.now()), unavailable);
  }

  async hold(actor: Actor, input: HoldInput): Promise<{ booking: BookingDto; replayed: boolean }> {
    if (actor.role !== 'CUSTOMER') throw new ForbiddenError('Only customers can book tickets');
    const seatIds = this.normalizeSeats(input.seatIds);

    if (input.idempotencyKey) {
      const existing = await this.bookings.findByIdempotencyKey(
        this.db,
        actor.id,
        input.idempotencyKey,
      );
      if (existing) return { booking: await this.view(existing.id), replayed: true };
    }

    const bookingId = randomUUID();
    const lockAttempt = await this.seatLocks.acquire(input.eventId, seatIds, bookingId);
    if (lockAttempt.status === 'CONTENDED') {
      // A retry of the same request may be contending with its own first attempt.
      const replay = input.idempotencyKey
        ? await this.awaitIdempotentBooking(actor.id, input.idempotencyKey)
        : null;
      if (replay) return { booking: await this.view(replay.id), replayed: true };
      throw await this.seatsUnavailable(seatIds);
    }
    const lock: Lock | null = lockAttempt.status === 'ACQUIRED' ? lockAttempt.lock : null;

    let expired: ExpiredBooking[];
    let holdExpiresAt: Date;
    try {
      ({ expired, holdExpiresAt } = await this.db.withTransaction(async (tx) => {
        const event = await this.bookings.lockEventForBooking(tx, input.eventId);
        this.assertOnSale(event);

        // Free seats whose holds already ran out so they can be taken now.
        const released = await this.expiry.expireWithin(tx, { eventId: event.id, limit: 500 });

        await this.bookings.lockCustomerForEvent(tx, actor.id, event.id);
        const active = await this.bookings.countActiveSeats(tx, actor.id, event.id);
        const max = this.options.maxTicketsPerUserPerEvent;
        if (active + seatIds.length > max) {
          throw new AppError(
            409,
            'TICKET_LIMIT_EXCEEDED',
            `You can hold or buy at most ${max} tickets for this event (you already have ${active}).`,
            [{ path: 'seatIds', message: `${Math.max(0, max - active)} more allowed` }],
          );
        }

        const seats = await this.bookings.findSeatsForPricing(tx, event.id, seatIds);
        if (seats.length !== seatIds.length) {
          throw new NotFoundError('One or more seats were not found in this event');
        }
        const quote = buildQuote(this.pricing, event, seats, this.now());

        const expiresAt = await this.bookings.insertBooking(tx, {
          id: bookingId,
          eventId: event.id,
          customerId: actor.id,
          holdSeconds: this.options.holdTtlSeconds,
          pricingStrategy: quote.appliedStrategy,
          totalAmountMinor: quote.totalMinor,
          currency: quote.currency,
          idempotencyKey: input.idempotencyKey ?? null,
        });
        await this.bookings.insertBookingSeats(
          tx,
          bookingId,
          event.id,
          quote.lines.map((line) => ({ seatId: line.seatId, priceMinor: line.unitPriceMinor })),
        );
        await this.bookings.insertHistory(tx, {
          bookingId,
          from: null,
          to: 'HELD',
          reason: 'seat hold',
          actorId: actor.id,
        });
        return { expired: released, holdExpiresAt: expiresAt };
      }));
    } catch (error) {
      if (lock) await this.seatLocks.release(lock);
      const raced =
        isUniqueViolation(error, 'uq_bookings_customer_idempotency') ||
        isUniqueViolation(error, 'idx_active_seat_per_event');
      if (input.idempotencyKey && raced) {
        const replay = await this.awaitIdempotentBooking(actor.id, input.idempotencyKey);
        if (replay) return { booking: await this.view(replay.id), replayed: true };
      }
      if (isUniqueViolation(error, 'idx_active_seat_per_event'))
        throw await this.seatsUnavailable(seatIds);
      throw error;
    }

    await this.expiry.releaseLocks(expired);
    if (lock) await this.seatLocks.extendToHold(lock, holdExpiresAt);
    return { booking: await this.view(bookingId), replayed: false };
  }

  /** HELD -> PENDING_PAYMENT: the customer confirms the selection and moves to payment. */
  async checkout(actor: Actor, bookingId: string): Promise<BookingDto> {
    const outcome = await this.db.withTransaction(async (tx) => {
      const booking = await this.lockOwned(tx, actor, bookingId);
      if (booking.status !== 'HELD') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Booking is ${booking.status.toLowerCase()}, not held`,
        );
      }
      if (await this.expireIfDue(tx, booking)) return 'EXPIRED' as const;
      await this.lifecycle.transition(tx, booking, 'PENDING_PAYMENT', {
        reason: 'checkout started',
        actorId: actor.id,
      });
      return 'OK' as const;
    });
    if (outcome === 'EXPIRED') {
      await this.releaseLocksOf(bookingId);
      throw new AppError(409, 'HOLD_EXPIRED', 'Your seat hold expired. Please select seats again.');
    }
    return this.view(bookingId);
  }

  /** HELD / PENDING_PAYMENT -> CANCELLED; seats are released immediately. */
  async cancel(actor: Actor, bookingId: string, reason?: string): Promise<BookingDto> {
    await this.db.withTransaction(async (tx) => {
      const booking = await this.lockOwned(tx, actor, bookingId);
      if (booking.status === 'CONFIRMED') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          'Confirmed bookings are cancelled through the refund flow',
        );
      }
      if (booking.status !== 'HELD' && booking.status !== 'PENDING_PAYMENT') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Booking is already ${booking.status.toLowerCase()}`,
        );
      }
      if (await this.expireIfDue(tx, booking)) return;
      await this.lifecycle.transition(tx, booking, 'CANCELLED', {
        reason: 'cancelled by customer',
        actorId: actor.id,
        cancellationReason: reason ?? 'Cancelled by customer before payment',
      });
    });
    await this.releaseLocksOf(bookingId);
    return this.view(bookingId);
  }

  /**
   * PENDING_PAYMENT -> CONFIRMED with pre-commit re-verification (ALGORITHMS §1.2).
   * Internal: invoked by the payment flow once a payment is verified server-side.
   */
  async confirm(
    bookingId: string,
    context: { reason: string; actorId?: string | null },
  ): Promise<BookingDto> {
    const outcome = await this.db.withTransaction(async (tx) => {
      const booking = await this.bookings.findForUpdate(tx, bookingId);
      if (!booking) throw new NotFoundError('Booking not found');
      if (booking.status !== 'PENDING_PAYMENT') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Cannot confirm a ${booking.status.toLowerCase()} booking`,
        );
      }
      if (await this.expireIfDue(tx, booking)) return 'EXPIRED' as const;
      await this.lifecycle.transition(tx, booking, 'CONFIRMED', {
        reason: context.reason,
        actorId: context.actorId ?? null,
      });
      return 'OK' as const;
    });
    await this.releaseLocksOf(bookingId);
    if (outcome === 'EXPIRED')
      throw new AppError(409, 'HOLD_EXPIRED', 'The seat hold expired before confirmation');
    return this.view(bookingId);
  }

  async get(actor: Actor, bookingId: string): Promise<BookingDto> {
    const view = await this.bookings.getView(this.db, bookingId);
    if (!view || (actor.role !== 'ADMIN' && view.customerId !== actor.id))
      throw new NotFoundError('Booking not found');
    return toBookingDto(view, this.now());
  }

  async list(actor: Actor, filter: { status?: BookingStatus; page: number; pageSize: number }) {
    const { items, total } = await this.bookings.listForCustomer(this.db, actor.id, filter);
    return {
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        eventId: item.eventId,
        event: {
          title: item.event.title,
          startAt: item.event.startAt.toISOString(),
          venueName: item.event.venueName,
          venueCity: item.event.venueCity,
          timezone: item.event.timezone,
        },
        seatCount: item.seatCount,
        totalAmountMinor: item.totalAmountMinor,
        currency: item.currency,
        holdExpiresAt:
          item.status === 'HELD' || item.status === 'PENDING_PAYMENT'
            ? iso(item.holdExpiresAt)
            : null,
        createdAt: item.createdAt.toISOString(),
      })),
      meta: buildPaginationMeta(filter.page, filter.pageSize, total),
    };
  }

  /** Waits briefly for a concurrent request with the same idempotency key to commit. */
  private async awaitIdempotentBooking(
    customerId: string,
    key: string,
  ): Promise<BookingCore | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const existing = await this.bookings.findByIdempotencyKey(this.db, customerId, key);
      if (existing) return existing;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  private normalizeSeats(seatIds: string[]): string[] {
    const unique = [...new Set(seatIds)];
    if (unique.length === 0)
      throw new ValidationError([{ path: 'seatIds', message: 'Select at least one seat' }]);
    if (unique.length > this.options.maxTicketsPerUserPerEvent) {
      throw new AppError(
        409,
        'TICKET_LIMIT_EXCEEDED',
        `You can hold or buy at most ${this.options.maxTicketsPerUserPerEvent} tickets for this event.`,
      );
    }
    return unique;
  }

  private assertOnSale(event: BookableEvent | null): asserts event is BookableEvent {
    if (!event || event.status !== 'PUBLISHED') throw new NotFoundError('Event not found');
    const now = this.now().getTime();
    if (event.startAt.getTime() <= now)
      throw new AppError(409, 'EVENT_NOT_ON_SALE', 'This event has already started');
    if (event.salesStartAt && event.salesStartAt.getTime() > now) {
      throw new AppError(409, 'EVENT_NOT_ON_SALE', 'Ticket sales have not opened yet');
    }
    if (event.salesEndAt && event.salesEndAt.getTime() <= now) {
      throw new AppError(409, 'EVENT_NOT_ON_SALE', 'Ticket sales have closed');
    }
  }

  /** Locks the booking and enforces ownership (other customers' bookings answer 404). */
  private async lockOwned(tx: Queryable, actor: Actor, bookingId: string): Promise<BookingCore> {
    const booking = await this.bookings.findForUpdate(tx, bookingId);
    if (!booking || (actor.role !== 'ADMIN' && booking.customerId !== actor.id)) {
      throw new NotFoundError('Booking not found');
    }
    return booking;
  }

  /** Expires a pre-confirmation booking whose hold ran out (DB clock). Returns true if it did. */
  private async expireIfDue(tx: Queryable, booking: BookingCore): Promise<boolean> {
    const { rows } = await tx.query<{ due: boolean }>('SELECT $1::timestamptz <= now() AS due', [
      booking.holdExpiresAt,
    ]);
    if (!rows[0]?.due) return false;
    await this.lifecycle.transition(tx, booking, 'EXPIRED', {
      reason: 'hold expired',
      actorId: null,
    });
    return true;
  }

  private async releaseLocksOf(bookingId: string): Promise<void> {
    const booking = await this.bookings.findCore(this.db, bookingId);
    if (!booking) return;
    const seatIds = await this.bookings.seatIdsOf(this.db, bookingId);
    await this.seatLocks.releaseForBooking(booking.eventId, seatIds, bookingId);
  }

  private async seatsUnavailable(seatIds: string[]): Promise<AppError> {
    const taken = await this.bookings.findUnavailableSeatIds(this.db, seatIds);
    return new AppError(
      409,
      'SEATS_UNAVAILABLE',
      'Some of the selected seats were just taken. Please choose different seats.',
      (taken.length > 0 ? taken : seatIds).map((seatId) => ({ path: 'seatIds', message: seatId })),
    );
  }

  private async view(bookingId: string): Promise<BookingDto> {
    const view = await this.bookings.getView(this.db, bookingId);
    if (!view) throw new NotFoundError('Booking not found');
    return toBookingDto(view, this.now());
  }
}
