import type { Logger } from 'pino';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type { BookingRepository } from '../../repositories/BookingRepository';
import type { BookingLifecycle } from './BookingLifecycle';
import type { SeatLockCoordinator } from './SeatLockCoordinator';

export interface ExpiredBooking {
  bookingId: string;
  eventId: string;
  seatIds: string[];
}

/**
 * Expires holds whose time is up: booking -> EXPIRED, seats -> RELEASED,
 * history appended, then Redis locks released. Idempotent and safe to run
 * concurrently (claims with FOR UPDATE SKIP LOCKED and re-checks state).
 */
export class BookingExpiryService {
  constructor(
    private readonly db: TransactionRunner,
    private readonly bookings: BookingRepository,
    private readonly lifecycle: BookingLifecycle,
    private readonly seatLocks: SeatLockCoordinator,
    private readonly logger?: Logger,
  ) {}

  /** Expires due holds inside an existing transaction (used by the hold flow for one event). */
  async expireWithin(
    tx: Queryable,
    options: { eventId?: string; limit: number },
  ): Promise<ExpiredBooking[]> {
    const claimed = await this.bookings.claimExpired(tx, options);
    const expired: ExpiredBooking[] = [];
    for (const booking of claimed) {
      const result = await this.lifecycle.transition(tx, booking, 'EXPIRED', {
        reason: 'hold expired',
        actorId: null,
      });
      expired.push({
        bookingId: booking.id,
        eventId: booking.eventId,
        seatIds: result.affectedSeatIds,
      });
    }
    return expired;
  }

  /** Releases Redis locks after the expiring transaction committed. */
  async releaseLocks(expired: ExpiredBooking[]): Promise<void> {
    for (const item of expired) {
      await this.seatLocks.releaseForBooking(item.eventId, item.seatIds, item.bookingId);
    }
  }

  /** One worker pass: processes up to `batchSize` bookings per transaction until none are due. */
  async expireDue(batchSize = 100, maxBatches = 50): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const expired = await this.db.withTransaction((tx) =>
        this.expireWithin(tx, { limit: batchSize }),
      );
      await this.releaseLocks(expired);
      total += expired.length;
      if (expired.length < batchSize) break;
    }
    if (total > 0) this.logger?.info({ expired: total }, 'Expired seat holds released');
    return total;
  }
}
