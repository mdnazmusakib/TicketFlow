import type TestAgent from 'supertest/lib/agent';
import { signUp, type ApiHarness } from './apiHarness';

export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export interface EventSetup {
  organizer: TestAgent;
  eventId: string;
  seatIds: string[];
  /** Seat ids grouped by row label. */
  rows: Record<string, string[]>;
}

/**
 * Creates an organizer, a venue and a PUBLISHED event through the real API.
 * Default: 3 rows x 5 seats, VIP row A at 2,000.00, Regular rows B-C at 1,000.00.
 */
export async function setupPublishedEvent(
  h: ApiHarness,
  options: {
    rows?: number;
    seatsPerRow?: number;
    pricing?: Record<string, unknown>;
    startInDays?: number;
    /** Price of the single "General" category when rows = 1 (default 1,000.00). */
    generalPriceMinor?: number;
  } = {},
): Promise<EventSetup> {
  const { agent: organizer } = await signUp(h, 'ORGANIZER');
  const venue = await organizer
    .post('/api/organizer/venues')
    .send({ name: `Hall ${Math.random()}`, address: '1 Road', city: 'Dhaka' })
    .expect(201);
  const rows = options.rows ?? 3;
  const labels = Array.from({ length: rows }, (_, i) => String.fromCharCode(65 + i));
  const created = await organizer
    .post('/api/organizer/events')
    .send({
      venueId: venue.body.data.id,
      title: 'Booking Test Event',
      startAt: inDays(options.startInDays ?? 30),
      pricing: options.pricing ?? { strategy: 'BASE' },
      seatMap: {
        rows,
        seatsPerRow: options.seatsPerRow ?? 5,
        categories:
          rows === 1
            ? [{ name: 'General', priceMinor: options.generalPriceMinor ?? 100000, rows: ['A'] }]
            : [
                { name: 'VIP', priceMinor: 200000, rows: ['A'] },
                { name: 'Regular', priceMinor: 100000, rows: labels.slice(1) },
              ],
      },
    })
    .expect(201);
  const eventId = created.body.data.id as string;
  await organizer.post(`/api/organizer/events/${eventId}/publish`).expect(200);

  const seats = created.body.data.seats as { id: string; row: string }[];
  const byRow: Record<string, string[]> = {};
  for (const seat of seats) (byRow[seat.row] ??= []).push(seat.id);
  return { organizer, eventId, seatIds: seats.map((s) => s.id), rows: byRow };
}

export async function newCustomer(h: ApiHarness): Promise<{ agent: TestAgent; userId: string }> {
  const { agent, userId } = await signUp(h, 'CUSTOMER');
  return { agent, userId };
}

/** Database snapshot of a booking's seats, for assertions independent of the API. */
export async function seatStates(h: ApiHarness, bookingId: string): Promise<string[]> {
  const { rows } = await h.testDb.db.query<{ seat_state: string }>(
    'SELECT seat_state FROM booking_seats WHERE booking_id = $1 ORDER BY seat_id',
    [bookingId],
  );
  return rows.map((row) => row.seat_state);
}

export async function activeAllocations(h: ApiHarness, eventId: string): Promise<number> {
  const { rows } = await h.testDb.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM booking_seats WHERE event_id = $1 AND seat_state IN ('HELD', 'BOOKED')`,
    [eventId],
  );
  return rows[0]?.n ?? 0;
}

/** Makes a booking's hold already expired (simulates 5 minutes passing). */
export async function expireHoldNow(h: ApiHarness, bookingId: string): Promise<void> {
  await h.testDb.db.query(
    `UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
    [bookingId],
  );
}
