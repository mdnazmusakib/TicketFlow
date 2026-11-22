import {
  assertBookingTransition,
  type BookingStatus,
  type SeatState,
} from '../../domain/lifecycle/bookingStateMachine';
import type { Queryable } from '../../infrastructure/database/types';
import type { BookingCore, BookingRepository } from '../../repositories/BookingRepository';

/** Seat allocation effect of entering each booking status. */
const SEAT_EFFECTS: Partial<Record<BookingStatus, { from: SeatState[]; to: SeatState }>> = {
  CONFIRMED: { from: ['HELD'], to: 'BOOKED' },
  EXPIRED: { from: ['HELD', 'BOOKED'], to: 'RELEASED' },
  CANCELLED: { from: ['HELD', 'BOOKED'], to: 'RELEASED' },
};

export interface TransitionResult {
  booking: BookingCore;
  /** Seats whose allocation changed (e.g. released), for Redis lock cleanup. */
  affectedSeatIds: string[];
}

export interface TransitionContext {
  reason: string;
  actorId: string | null;
  cancellationReason?: string | null;
  /** Extra facts for observers (e.g. the refund decision of a cancellation). */
  details?: Record<string, unknown>;
}

export interface BookingTransitionEvent {
  booking: BookingCore;
  from: BookingStatus;
  to: BookingStatus;
  context: TransitionContext;
}

/**
 * Observer of booking status changes. Runs INSIDE the transaction that makes
 * the change, so whatever it writes (e.g. notification outbox rows) commits or
 * rolls back together with the status change.
 */
export type BookingTransitionListener = (
  tx: Queryable,
  event: BookingTransitionEvent,
) => Promise<void>;

/**
 * The single place where booking status changes are written. Every change:
 * 1. is validated against the central state machine (invalid -> throws),
 * 2. applies the matching seat-allocation change,
 * 3. appends booking_status_history,
 * 4. notifies registered listeners (Observer pattern: notifications plug in
 *    here without changing booking code),
 * all inside the caller's transaction (the booking row must already be locked).
 * The database trigger re-validates the same map as a safety net.
 */
export class BookingLifecycle {
  private readonly listeners: BookingTransitionListener[] = [];

  constructor(private readonly bookings: BookingRepository) {}

  onTransition(listener: BookingTransitionListener): void {
    this.listeners.push(listener);
  }

  async transition(
    tx: Queryable,
    booking: BookingCore,
    to: BookingStatus,
    context: TransitionContext,
  ): Promise<TransitionResult> {
    assertBookingTransition(booking.status, to);
    await this.bookings.setStatus(tx, booking.id, to, {
      cancellationReason: context.cancellationReason ?? null,
    });
    const effect = SEAT_EFFECTS[to];
    const affectedSeatIds = effect
      ? await this.bookings.updateSeatStates(tx, booking.id, effect.from, effect.to)
      : [];
    await this.bookings.insertHistory(tx, {
      bookingId: booking.id,
      from: booking.status,
      to,
      reason: context.reason,
      actorId: context.actorId,
    });
    for (const listener of this.listeners) {
      await listener(tx, { booking, from: booking.status, to, context });
    }
    return { booking: { ...booking, status: to }, affectedSeatIds };
  }
}
