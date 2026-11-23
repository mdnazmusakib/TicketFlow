import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../src/infrastructure/database/types';

/** Minimal valid rows for schema tests. Password hashes are dummies (never verified). */
export async function insertUser(
  db: Queryable,
  role: 'CUSTOMER' | 'ORGANIZER' | 'ADMIN' = 'CUSTOMER',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`${role} user`, `${randomUUID()}@example.com`, role],
  );
  return rows[0]!.id;
}

export interface EventFixture {
  organizerId: string;
  venueId: string;
  eventId: string;
  categoryId: string;
  seatIds: string[];
}

export async function insertEventWithSeats(
  db: Queryable,
  options: { seats?: number; startInHours?: number } = {},
): Promise<EventFixture> {
  const seatCount = options.seats ?? 4;
  const organizerId = await insertUser(db, 'ORGANIZER');
  const venue = await db.query<{ id: string }>(
    `INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, $2, 'Addr', 'Dhaka') RETURNING id`,
    [organizerId, `Venue ${randomUUID()}`],
  );
  const venueId = venue.rows[0]!.id;
  const event = await db.query<{ id: string }>(
    `INSERT INTO events (organizer_id, venue_id, title, start_at, seat_rows, seats_per_row)
     VALUES ($1, $2, 'Event', now() + make_interval(hours => $3), 1, $4) RETURNING id`,
    [organizerId, venueId, options.startInHours ?? 48, seatCount],
  );
  const eventId = event.rows[0]!.id;
  const category = await db.query<{ id: string }>(
    `INSERT INTO seat_categories (event_id, name, price_minor) VALUES ($1, 'General', 100000) RETURNING id`,
    [eventId],
  );
  const categoryId = category.rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    `INSERT INTO seats (event_id, category_id, row_label, seat_number)
     SELECT $1, $2, 'A', n FROM generate_series(1, $3::int) AS n RETURNING id`,
    [eventId, categoryId, seatCount],
  );
  return { organizerId, venueId, eventId, categoryId, seatIds: seats.rows.map((r) => r.id) };
}

export async function insertBooking(
  db: Queryable,
  eventId: string,
  customerId: string,
  totalMinor = 100000,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO bookings (event_id, customer_id, hold_expires_at, pricing_strategy, total_amount_minor,
       ticket_subtotal_minor, currency)
     VALUES ($1, $2, now() + interval '5 minutes', 'BASE', $3, $3, 'BDT') RETURNING id`,
    [eventId, customerId, totalMinor],
  );
  return rows[0]!.id;
}

export async function holdSeat(
  db: Queryable,
  bookingId: string,
  eventId: string,
  seatId: string,
  priceMinor = 100000,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO booking_seats (booking_id, event_id, seat_id, price_minor) VALUES ($1, $2, $3, $4) RETURNING id`,
    [bookingId, eventId, seatId, priceMinor],
  );
  return rows[0]!.id;
}

/** Captures the PostgreSQL error code (SQLSTATE) and constraint of a failing statement. */
export async function pgFailure(
  promise: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message: string };
    return { code: e.code, constraint: e.constraint, message: e.message };
  }
  throw new Error('Expected the statement to fail');
}
