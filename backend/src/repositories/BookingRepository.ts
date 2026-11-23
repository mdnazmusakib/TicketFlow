import type { BookingStatus, SeatState } from '../domain/lifecycle/bookingStateMachine';
import type { Queryable } from '../infrastructure/database/types';
import { ACTIVE_ALLOCATION_SQL } from './EventRepository';

export interface BookableEvent {
  id: string;
  status: string;
  startAt: Date;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  pricingStrategy: string;
  earlyBirdDeadline: Date | null;
  earlyBirdDiscountPct: number | null;
  currency: string;
}

export interface SeatForPricing {
  seatId: string;
  rowLabel: string;
  seatNumber: number;
  categoryId: string;
  categoryName: string;
  basePriceMinor: number;
}

/** Immutable financial snapshot stored with the booking (migration 0009). */
export interface BookingCharges {
  ticketSubtotalMinor: number;
  platformFeeMinor: number;
  platformFeePerSeatMinor: number;
  vatMinor: number;
  vatRateBps: number;
}

export interface BookingCore {
  id: string;
  eventId: string;
  customerId: string;
  status: BookingStatus;
  holdExpiresAt: Date | null;
  /** Grand total charged = ticket subtotal + platform fee + VAT. */
  totalAmountMinor: number;
  currency: string;
  charges: BookingCharges;
}

export interface BookingSeatView {
  seatId: string;
  rowLabel: string;
  seatNumber: number;
  categoryName: string;
  priceMinor: number;
  seatState: SeatState;
}

export interface BookingHistoryEntry {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  reason: string | null;
  changedAt: Date;
}

export interface BookingView extends BookingCore {
  pricingStrategy: string;
  refundAmountMinor: number;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  event: { title: string; startAt: Date; venueName: string; venueCity: string; timezone: string };
  seats: BookingSeatView[];
  history: BookingHistoryEntry[];
}

export interface BookingSummary extends BookingCore {
  createdAt: Date;
  seatCount: number;
  event: { title: string; startAt: Date; venueName: string; venueCity: string; timezone: string };
}

export interface NewBooking {
  id: string;
  eventId: string;
  customerId: string;
  holdSeconds: number;
  pricingStrategy: string;
  totalAmountMinor: number;
  currency: string;
  idempotencyKey: string | null;
  charges: BookingCharges;
}

interface CoreRow {
  id: string;
  event_id: string;
  customer_id: string;
  status: BookingStatus;
  hold_expires_at: Date | null;
  total_amount_minor: string;
  currency: string;
  ticket_subtotal_minor: string;
  platform_fee_minor: string;
  platform_fee_per_seat_minor: string;
  vat_minor: string;
  vat_rate_bps: number;
}

const toCore = (row: CoreRow): BookingCore => ({
  id: row.id,
  eventId: row.event_id,
  customerId: row.customer_id,
  status: row.status,
  holdExpiresAt: row.hold_expires_at,
  totalAmountMinor: Number(row.total_amount_minor),
  currency: row.currency,
  charges: {
    ticketSubtotalMinor: Number(row.ticket_subtotal_minor),
    platformFeeMinor: Number(row.platform_fee_minor),
    platformFeePerSeatMinor: Number(row.platform_fee_per_seat_minor),
    vatMinor: Number(row.vat_minor),
    vatRateBps: Number(row.vat_rate_bps),
  },
});

const CORE_COLUMNS =
  'b.id, b.event_id, b.customer_id, b.status, b.hold_expires_at, b.total_amount_minor, b.currency, ' +
  'b.ticket_subtotal_minor, b.platform_fee_minor, b.platform_fee_per_seat_minor, b.vat_minor, b.vat_rate_bps';

export class BookingRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Locks the event row in SHARE mode for the hold transaction: holds run in
   * parallel with each other, but organizer edits (FOR UPDATE) wait for them.
   */
  async lockEventForBooking(tx: Queryable, eventId: string): Promise<BookableEvent | null> {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      start_at: Date;
      sales_start_at: Date | null;
      sales_end_at: Date | null;
      pricing_strategy: string;
      early_bird_deadline: Date | null;
      early_bird_discount_pct: number | null;
      currency: string;
    }>(
      `SELECT id, status, start_at, sales_start_at, sales_end_at, pricing_strategy,
              early_bird_deadline, early_bird_discount_pct, currency
       FROM events WHERE id = $1 FOR SHARE`,
      [eventId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      startAt: row.start_at,
      salesStartAt: row.sales_start_at,
      salesEndAt: row.sales_end_at,
      pricingStrategy: row.pricing_strategy,
      earlyBirdDeadline: row.early_bird_deadline,
      earlyBirdDiscountPct: row.early_bird_discount_pct,
      currency: row.currency,
    };
  }

  /** Serialises all hold attempts of one customer for one event (ticket-limit check). */
  async lockCustomerForEvent(tx: Queryable, customerId: string, eventId: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `booking:${customerId}:${eventId}`,
    ]);
  }

  /** Seats currently held (unexpired) or booked by the customer for the event. */
  async countActiveSeats(tx: Queryable, customerId: string, eventId: string): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
       WHERE b.customer_id = $1 AND b.event_id = $2 AND ${ACTIVE_ALLOCATION_SQL}`,
      [customerId, eventId],
    );
    return rows[0]?.n ?? 0;
  }

  async findSeatsForPricing(
    db: Queryable,
    eventId: string,
    seatIds: string[],
  ): Promise<SeatForPricing[]> {
    const { rows } = await db.query<{
      id: string;
      row_label: string;
      seat_number: number;
      category_id: string;
      category_name: string;
      price_minor: string;
    }>(
      `SELECT s.id, s.row_label, s.seat_number, c.id AS category_id, c.name AS category_name, c.price_minor
       FROM seats s JOIN seat_categories c ON c.id = s.category_id
       WHERE s.event_id = $1 AND s.id = ANY($2::uuid[])
       ORDER BY length(s.row_label), s.row_label, s.seat_number`,
      [eventId, seatIds],
    );
    return rows.map((row) => ({
      seatId: row.id,
      rowLabel: row.row_label,
      seatNumber: row.seat_number,
      categoryId: row.category_id,
      categoryName: row.category_name,
      basePriceMinor: Number(row.price_minor),
    }));
  }

  /** Seats among `seatIds` that are blocked by an active allocation right now. */
  async findUnavailableSeatIds(db: Queryable, seatIds: string[]): Promise<string[]> {
    const { rows } = await db.query<{ seat_id: string }>(
      `SELECT DISTINCT bs.seat_id FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
       WHERE bs.seat_id = ANY($1::uuid[]) AND ${ACTIVE_ALLOCATION_SQL}`,
      [seatIds],
    );
    return rows.map((row) => row.seat_id);
  }

  /**
   * Claims expired pre-confirmation bookings for processing. SKIP LOCKED lets
   * several workers (or a worker and a hold request) run without blocking or
   * processing the same booking twice.
   */
  async claimExpired(
    tx: Queryable,
    options: { eventId?: string; limit: number },
  ): Promise<BookingCore[]> {
    const { rows } = await tx.query<CoreRow>(
      `SELECT ${CORE_COLUMNS} FROM bookings b
       WHERE b.status IN ('HELD', 'PENDING_PAYMENT') AND b.hold_expires_at <= now()
         AND ($1::uuid IS NULL OR b.event_id = $1)
       ORDER BY b.hold_expires_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [options.eventId ?? null, options.limit],
    );
    return rows.map(toCore);
  }

  /** Inserts a HELD booking; the expiry uses the database clock (same clock as every availability check). */
  async insertBooking(tx: Queryable, booking: NewBooking): Promise<Date> {
    const { rows } = await tx.query<{ hold_expires_at: Date }>(
      `INSERT INTO bookings (id, event_id, customer_id, status, hold_expires_at, pricing_strategy,
         total_amount_minor, currency, idempotency_key, ticket_subtotal_minor, platform_fee_minor,
         platform_fee_per_seat_minor, vat_minor, vat_rate_bps)
       VALUES ($1, $2, $3, 'HELD', now() + make_interval(secs => $4), $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING hold_expires_at`,
      [
        booking.id,
        booking.eventId,
        booking.customerId,
        booking.holdSeconds,
        booking.pricingStrategy,
        booking.totalAmountMinor,
        booking.currency,
        booking.idempotencyKey,
        booking.charges.ticketSubtotalMinor,
        booking.charges.platformFeeMinor,
        booking.charges.platformFeePerSeatMinor,
        booking.charges.vatMinor,
        booking.charges.vatRateBps,
      ],
    );
    return rows[0]!.hold_expires_at;
  }

  /** Inserts HELD allocations; `idx_active_seat_per_event` rejects any seat already taken. */
  async insertBookingSeats(
    tx: Queryable,
    bookingId: string,
    eventId: string,
    lines: { seatId: string; priceMinor: number }[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO booking_seats (booking_id, event_id, seat_id, price_minor)
       SELECT $1, $2, s, p FROM unnest($3::uuid[], $4::bigint[]) AS t(s, p)`,
      [bookingId, eventId, lines.map((line) => line.seatId), lines.map((line) => line.priceMinor)],
    );
  }

  async insertHistory(
    tx: Queryable,
    entry: {
      bookingId: string;
      from: BookingStatus | null;
      to: BookingStatus;
      reason: string;
      actorId: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO booking_status_history (booking_id, from_status, to_status, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.bookingId, entry.from, entry.to, entry.reason, entry.actorId],
    );
  }

  async findForUpdate(tx: Queryable, id: string): Promise<BookingCore | null> {
    const { rows } = await tx.query<CoreRow>(
      `SELECT ${CORE_COLUMNS} FROM bookings b WHERE b.id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? toCore(rows[0]) : null;
  }

  async findByIdempotencyKey(
    db: Queryable,
    customerId: string,
    key: string,
  ): Promise<BookingCore | null> {
    const { rows } = await db.query<CoreRow>(
      `SELECT ${CORE_COLUMNS} FROM bookings b WHERE b.customer_id = $1 AND b.idempotency_key = $2`,
      [customerId, key],
    );
    return rows[0] ? toCore(rows[0]) : null;
  }

  /**
   * Whether a seat-lock owner still needs its lock: unknown ids count as active
   * (the owning request may still be inside its transaction).
   */
  async isLockOwnerActive(db: Queryable, bookingId: string): Promise<boolean> {
    const { rows } = await db.query<{ active: boolean }>(
      `SELECT (status IN ('HELD', 'PENDING_PAYMENT') AND hold_expires_at > now()) AS active
       FROM bookings WHERE id = $1`,
      [bookingId],
    );
    return rows[0]?.active ?? true;
  }

  /** Keeps seats reserved while the customer pays: expiry becomes at least now + seconds. */
  async extendHold(tx: Queryable, id: string, seconds: number): Promise<Date> {
    const { rows } = await tx.query<{ hold_expires_at: Date }>(
      `UPDATE bookings SET hold_expires_at = GREATEST(hold_expires_at, now() + make_interval(secs => $2))
       WHERE id = $1 RETURNING hold_expires_at`,
      [id, seconds],
    );
    return rows[0]!.hold_expires_at;
  }

  async findEventStart(db: Queryable, bookingId: string): Promise<Date | null> {
    const { rows } = await db.query<{ start_at: Date }>(
      'SELECT e.start_at FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = $1',
      [bookingId],
    );
    return rows[0]?.start_at ?? null;
  }

  async findCore(db: Queryable, id: string): Promise<BookingCore | null> {
    const { rows } = await db.query<CoreRow>(
      `SELECT ${CORE_COLUMNS} FROM bookings b WHERE b.id = $1`,
      [id],
    );
    return rows[0] ? toCore(rows[0]) : null;
  }

  async setStatus(
    tx: Queryable,
    id: string,
    to: BookingStatus,
    options: { cancellationReason?: string | null } = {},
  ): Promise<void> {
    await tx.query(
      `UPDATE bookings SET status = $2::varchar,
         confirmed_at = CASE WHEN $2::varchar = 'CONFIRMED' THEN now() ELSE confirmed_at END,
         cancelled_at = CASE WHEN $2::varchar = 'CANCELLED' THEN now() ELSE cancelled_at END,
         expired_at = CASE WHEN $2::varchar = 'EXPIRED' THEN now() ELSE expired_at END,
         cancellation_reason = CASE WHEN $2::varchar = 'CANCELLED' THEN $3 ELSE cancellation_reason END
       WHERE id = $1`,
      [id, to, options.cancellationReason ?? null],
    );
  }

  /** Moves this booking's seats between states; returns the affected seat ids. */
  async updateSeatStates(
    tx: Queryable,
    bookingId: string,
    from: SeatState[],
    to: SeatState,
  ): Promise<string[]> {
    const { rows } = await tx.query<{ seat_id: string }>(
      `UPDATE booking_seats SET seat_state = $3::varchar,
         released_at = CASE WHEN $3::varchar = 'RELEASED' THEN now() ELSE released_at END
       WHERE booking_id = $1 AND seat_state = ANY($2::varchar[])
       RETURNING seat_id`,
      [bookingId, from, to],
    );
    return rows.map((row) => row.seat_id);
  }

  async seatIdsOf(db: Queryable, bookingId: string): Promise<string[]> {
    const { rows } = await db.query<{ seat_id: string }>(
      'SELECT seat_id FROM booking_seats WHERE booking_id = $1',
      [bookingId],
    );
    return rows.map((row) => row.seat_id);
  }

  async getView(db: Queryable, id: string): Promise<BookingView | null> {
    const { rows } = await db.query<
      CoreRow & {
        pricing_strategy: string;
        refund_amount_minor: string;
        confirmed_at: Date | null;
        cancelled_at: Date | null;
        expired_at: Date | null;
        cancellation_reason: string | null;
        created_at: Date;
        updated_at: Date;
        title: string;
        start_at: Date;
        venue_name: string;
        venue_city: string;
        timezone: string;
      }
    >(
      `SELECT ${CORE_COLUMNS}, b.pricing_strategy, b.refund_amount_minor, b.confirmed_at, b.cancelled_at,
              b.expired_at, b.cancellation_reason, b.created_at, b.updated_at,
              e.title, e.start_at, v.name AS venue_name, v.city AS venue_city, v.timezone
       FROM bookings b JOIN events e ON e.id = b.event_id JOIN venues v ON v.id = e.venue_id
       WHERE b.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;

    const [seats, history] = await Promise.all([
      db.query<{
        seat_id: string;
        row_label: string;
        seat_number: number;
        category_name: string;
        price_minor: string;
        seat_state: SeatState;
      }>(
        `SELECT bs.seat_id, s.row_label, s.seat_number, c.name AS category_name, bs.price_minor, bs.seat_state
         FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id JOIN seat_categories c ON c.id = s.category_id
         WHERE bs.booking_id = $1 ORDER BY length(s.row_label), s.row_label, s.seat_number`,
        [id],
      ),
      db.query<{
        from_status: BookingStatus | null;
        to_status: BookingStatus;
        reason: string | null;
        changed_at: Date;
      }>(
        `SELECT from_status, to_status, reason, changed_at FROM booking_status_history
         WHERE booking_id = $1 ORDER BY changed_at, id`,
        [id],
      ),
    ]);

    return {
      ...toCore(row),
      pricingStrategy: row.pricing_strategy,
      refundAmountMinor: Number(row.refund_amount_minor),
      confirmedAt: row.confirmed_at,
      cancelledAt: row.cancelled_at,
      expiredAt: row.expired_at,
      cancellationReason: row.cancellation_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      event: {
        title: row.title,
        startAt: row.start_at,
        venueName: row.venue_name,
        venueCity: row.venue_city,
        timezone: row.timezone,
      },
      seats: seats.rows.map((seat) => ({
        seatId: seat.seat_id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        categoryName: seat.category_name,
        priceMinor: Number(seat.price_minor),
        seatState: seat.seat_state,
      })),
      history: history.rows.map((entry) => ({
        fromStatus: entry.from_status,
        toStatus: entry.to_status,
        reason: entry.reason,
        changedAt: entry.changed_at,
      })),
    };
  }

  async listForCustomer(
    db: Queryable,
    customerId: string,
    filter: { status?: BookingStatus; page: number; pageSize: number },
  ): Promise<{ items: BookingSummary[]; total: number }> {
    const { rows } = await db.query<
      CoreRow & {
        created_at: Date;
        seat_count: number;
        title: string;
        start_at: Date;
        venue_name: string;
        venue_city: string;
        timezone: string;
        total_count: number;
      }
    >(
      `SELECT ${CORE_COLUMNS}, b.created_at,
              (SELECT count(*)::int FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count,
              e.title, e.start_at, v.name AS venue_name, v.city AS venue_city, v.timezone,
              count(*) OVER()::int AS total_count
       FROM bookings b JOIN events e ON e.id = b.event_id JOIN venues v ON v.id = e.venue_id
       WHERE b.customer_id = $1 AND ($2::varchar IS NULL OR b.status = $2)
       ORDER BY b.created_at DESC, b.id
       LIMIT $3 OFFSET $4`,
      [customerId, filter.status ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return {
      items: rows.map((row) => ({
        ...toCore(row),
        createdAt: row.created_at,
        seatCount: row.seat_count,
        event: {
          title: row.title,
          startAt: row.start_at,
          venueName: row.venue_name,
          venueCity: row.venue_city,
          timezone: row.timezone,
        },
      })),
      total: rows[0]?.total_count ?? 0,
    };
  }
}
