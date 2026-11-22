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

/**
 * The single place where booking status changes are written. Every change:
 * 1. is validated against the central state machine (invalid -> throws),
 * 2. applies the matching seat-allocation change,
 * 3. appends booking_status_history,
 * all inside the caller's transaction (the booking row must already be locked).
 * The database trigger re-validates the same map as a safety net.
 */
export class BookingLifecycle {
  constructor(private readonly bookings: BookingRepository) {}

  async transition(
    tx: Queryable,
    booking: BookingCore,
    to: BookingStatus,
    context: { reason: string; actorId: string | null; cancellationReason?: string | null },
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
    return { booking: { ...booking, status: to }, affectedSeatIds };
  }
}
