import {
  BOOKING_STATUSES,
  canTransitionBooking,
  type BookingStatus,
} from '../../../src/domain/lifecycle/bookingStateMachine';
import { createTestDatabase, type TestDatabase } from '../../helpers/testDatabase';
import {
  holdSeat,
  insertBooking,
  insertEventWithSeats,
  insertUser,
  pgFailure,
  type EventFixture,
} from '../../helpers/fixtures';

/** Moves a fresh booking to `status` along a valid path, filling required timestamps. */
async function driveTo(
  testDb: TestDatabase,
  bookingId: string,
  status: BookingStatus,
): Promise<void> {
  const path: Record<BookingStatus, BookingStatus[]> = {
    HELD: [],
    PENDING_PAYMENT: ['PENDING_PAYMENT'],
    CONFIRMED: ['PENDING_PAYMENT', 'CONFIRMED'],
    EXPIRED: ['EXPIRED'],
    CANCELLED: ['CANCELLED'],
  };
  for (const step of path[status]) await setStatus(testDb, bookingId, step);
}

function setStatus(testDb: TestDatabase, bookingId: string, status: BookingStatus) {
  return testDb.pool.query(
    `UPDATE bookings SET status = $2::varchar,
       confirmed_at = CASE WHEN $2::varchar = 'CONFIRMED' THEN now() ELSE confirmed_at END,
       cancelled_at = CASE WHEN $2::varchar = 'CANCELLED' THEN now() ELSE cancelled_at END,
       expired_at   = CASE WHEN $2::varchar = 'EXPIRED'   THEN now() ELSE expired_at END
     WHERE id = $1`,
    [bookingId, status],
  );
}

describe('schema integrity (real PostgreSQL)', () => {
  let testDb: TestDatabase;
  let fx: EventFixture;
  let customerId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: true });
  });

  beforeEach(async () => {
    fx = await insertEventWithSeats(testDb.pool);
    customerId = await insertUser(testDb.pool);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  describe('double-booking prevention', () => {
    it('rejects a second active allocation of the same seat', async () => {
      const first = await insertBooking(testDb.pool, fx.eventId, customerId);
      await holdSeat(testDb.pool, first, fx.eventId, fx.seatIds[0]!);

      const otherCustomer = await insertUser(testDb.pool);
      const second = await insertBooking(testDb.pool, fx.eventId, otherCustomer);
      const failure = await pgFailure(holdSeat(testDb.pool, second, fx.eventId, fx.seatIds[0]!));
      expect(failure).toMatchObject({ code: '23505', constraint: 'idx_active_seat_per_event' });
    });

    it('lets exactly one of many concurrent transactions hold the same seat', async () => {
      const contenders = await Promise.all(
        Array.from({ length: 8 }, async () =>
          insertBooking(testDb.pool, fx.eventId, await insertUser(testDb.pool)),
        ),
      );
      const outcomes = await Promise.allSettled(
        contenders.map((bookingId) =>
          testDb.db.withTransaction(async (tx) => {
            await holdSeat(tx, bookingId, fx.eventId, fx.seatIds[1]!);
            // Widen the race window inside the transaction.
            await tx.query('SELECT pg_sleep(0.05)');
          }),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(rejected.every((o) => (o.reason as { code?: string }).code === '23505')).toBe(true);
    });

    it('frees the seat once the allocation is RELEASED, keeping history', async () => {
      const first = await insertBooking(testDb.pool, fx.eventId, customerId);
      const allocation = await holdSeat(testDb.pool, first, fx.eventId, fx.seatIds[2]!);
      await testDb.pool.query(
        `UPDATE booking_seats SET seat_state = 'RELEASED', released_at = now() WHERE id = $1`,
        [allocation],
      );
      const second = await insertBooking(testDb.pool, fx.eventId, await insertUser(testDb.pool));
      await expect(
        holdSeat(testDb.pool, second, fx.eventId, fx.seatIds[2]!),
      ).resolves.toBeDefined();
      const { rows } = await testDb.pool.query(
        'SELECT count(*)::int AS n FROM booking_seats WHERE seat_id = $1',
        [fx.seatIds[2]],
      );
      expect(rows[0].n).toBe(2);
    });

    it('never re-activates a RELEASED allocation', async () => {
      const booking = await insertBooking(testDb.pool, fx.eventId, customerId);
      const allocation = await holdSeat(testDb.pool, booking, fx.eventId, fx.seatIds[3]!);
      await testDb.pool.query(
        `UPDATE booking_seats SET seat_state = 'RELEASED', released_at = now() WHERE id = $1`,
        [allocation],
      );
      const failure = await pgFailure(
        testDb.pool.query(
          `UPDATE booking_seats SET seat_state = 'HELD', released_at = NULL WHERE id = $1`,
          [allocation],
        ),
      );
      expect(failure.message).toContain('invalid seat state transition RELEASED -> HELD');
    });
  });

  describe('same-event integrity (composite foreign keys)', () => {
    it('rejects booking a seat that belongs to another event', async () => {
      const other = await insertEventWithSeats(testDb.pool);
      const booking = await insertBooking(testDb.pool, fx.eventId, customerId);
      const failure = await pgFailure(
        holdSeat(testDb.pool, booking, fx.eventId, other.seatIds[0]!),
      );
      expect(failure).toMatchObject({
        code: '23503',
        constraint: 'fk_booking_seats_seat_same_event',
      });
    });

    it('rejects a seat whose category belongs to another event', async () => {
      const other = await insertEventWithSeats(testDb.pool);
      const failure = await pgFailure(
        testDb.pool.query(
          `INSERT INTO seats (event_id, category_id, row_label, seat_number) VALUES ($1, $2, 'B', 1)`,
          [fx.eventId, other.categoryId],
        ),
      );
      expect(failure).toMatchObject({ code: '23503', constraint: 'fk_seats_category_same_event' });
    });

    it("rejects an event at another organizer's venue", async () => {
      const intruder = await insertUser(testDb.pool, 'ORGANIZER');
      const failure = await pgFailure(
        testDb.pool.query(
          `INSERT INTO events (organizer_id, venue_id, title, start_at, seat_rows, seats_per_row)
           VALUES ($1, $2, 'X', now() + interval '1 day', 1, 1)`,
          [intruder, fx.venueId],
        ),
      );
      expect(failure).toMatchObject({
        code: '23503',
        constraint: 'fk_events_venue_same_organizer',
      });
    });

    it('deleting an event without bookings cascades to categories and seats', async () => {
      const lonely = await insertEventWithSeats(testDb.pool);
      await testDb.pool.query('DELETE FROM events WHERE id = $1', [lonely.eventId]);
      const { rows } = await testDb.pool.query(
        'SELECT count(*)::int AS n FROM seats WHERE event_id = $1',
        [lonely.eventId],
      );
      expect(rows[0].n).toBe(0);
    });

    it('blocks deleting an event that has bookings (financial history)', async () => {
      await insertBooking(testDb.pool, fx.eventId, customerId);
      const failure = await pgFailure(
        testDb.pool.query('DELETE FROM events WHERE id = $1', [fx.eventId]),
      );
      // ON DELETE RESTRICT => restrict_violation
      expect(failure.code).toBe('23001');
    });
  });

  describe('booking lifecycle trigger', () => {
    it('matches the domain transition map for every status pair', async () => {
      const mismatches: string[] = [];
      for (const from of BOOKING_STATUSES) {
        for (const to of BOOKING_STATUSES) {
          if (from === to) continue;
          const bookingId = await insertBooking(
            testDb.pool,
            fx.eventId,
            await insertUser(testDb.pool),
          );
          await driveTo(testDb, bookingId, from);
          const allowedByDb = await setStatus(testDb, bookingId, to).then(
            () => true,
            () => false,
          );
          if (allowedByDb !== canTransitionBooking(from, to)) mismatches.push(`${from}->${to}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('requires new bookings to start in HELD', async () => {
      const failure = await pgFailure(
        testDb.pool.query(
          `INSERT INTO bookings (event_id, customer_id, status, confirmed_at, pricing_strategy, total_amount_minor, currency)
           VALUES ($1, $2, 'CONFIRMED', now(), 'BASE', 1000, 'BDT')`,
          [fx.eventId, customerId],
        ),
      );
      expect(failure.message).toContain('must be created in HELD state');
    });

    it('makes the charged amount immutable', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId);
      const failure = await pgFailure(
        testDb.pool.query('UPDATE bookings SET total_amount_minor = 1 WHERE id = $1', [bookingId]),
      );
      expect(failure.message).toContain('immutable');
    });

    it('enforces amount and timestamp consistency checks', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId, 5000);
      expect(
        (
          await pgFailure(
            testDb.pool.query('UPDATE bookings SET refund_amount_minor = 10 WHERE id = $1', [
              bookingId,
            ]),
          )
        ).constraint,
      ).toBe('chk_bookings_refund_only_when_cancelled');
      await setStatus(testDb, bookingId, 'CANCELLED');
      expect(
        (
          await pgFailure(
            testDb.pool.query('UPDATE bookings SET refund_amount_minor = 6000 WHERE id = $1', [
              bookingId,
            ]),
          )
        ).constraint,
      ).toBe('chk_bookings_amounts');
      await expect(
        testDb.pool.query('UPDATE bookings SET refund_amount_minor = 5000 WHERE id = $1', [
          bookingId,
        ]),
      ).resolves.toBeDefined();
      const pending = await insertBooking(testDb.pool, fx.eventId, customerId);
      await setStatus(testDb, pending, 'PENDING_PAYMENT');
      expect(
        (
          await pgFailure(
            testDb.pool.query('UPDATE bookings SET hold_expires_at = NULL WHERE id = $1', [
              pending,
            ]),
          )
        ).constraint,
      ).toBe('chk_bookings_hold_expiry');
      expect(
        (
          await pgFailure(
            testDb.pool.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1`, [pending]),
          )
        ).constraint,
      ).toBe('chk_bookings_confirmed_at');
    });

    it('keeps booking_status_history append-only', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId);
      const { rows } = await testDb.pool.query<{ id: string }>(
        `INSERT INTO booking_status_history (booking_id, from_status, to_status, reason)
         VALUES ($1, NULL, 'HELD', 'seat hold') RETURNING id`,
        [bookingId],
      );
      const update = await pgFailure(
        testDb.pool.query(`UPDATE booking_status_history SET reason = 'x' WHERE id = $1`, [
          rows[0]!.id,
        ]),
      );
      expect(update.message).toContain('append-only');
      const del = await pgFailure(
        testDb.pool.query('DELETE FROM booking_status_history WHERE id = $1', [rows[0]!.id]),
      );
      expect(del.message).toContain('append-only');
      const firstMustBeHeld = await pgFailure(
        testDb.pool.query(
          `INSERT INTO booking_status_history (booking_id, to_status) VALUES ($1, 'CONFIRMED')`,
          [bookingId],
        ),
      );
      expect(firstMustBeHeld.constraint).toBe('chk_bsh_initial_is_held');
    });
  });

  describe('payments and refunds', () => {
    async function insertPayment(bookingId: string, key: string, status = 'INITIATED') {
      return testDb.pool.query<{ id: string }>(
        `INSERT INTO payments (booking_id, provider, amount_minor, currency, status, idempotency_key, paid_at)
         VALUES ($1, 'MOCK_PROVIDER_A', 100000, 'BDT', $2, $3, CASE WHEN $2::varchar = 'SUCCEEDED' THEN now() END)
         RETURNING id`,
        [bookingId, status, key],
      );
    }

    it('allows only one successful payment per booking (no double charge)', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId);
      await insertPayment(bookingId, `k-${bookingId}-1`, 'SUCCEEDED');
      await insertPayment(bookingId, `k-${bookingId}-2`, 'FAILED');
      const failure = await pgFailure(insertPayment(bookingId, `k-${bookingId}-3`, 'SUCCEEDED'));
      expect(failure.constraint).toBe('uq_payments_one_success_per_booking');
    });

    it('rejects a reused idempotency key', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId);
      await insertPayment(bookingId, `dup-${bookingId}`);
      expect((await pgFailure(insertPayment(bookingId, `dup-${bookingId}`))).constraint).toBe(
        'uq_payments_idempotency_key',
      );
    });

    it('allows at most one live refund per payment', async () => {
      const bookingId = await insertBooking(testDb.pool, fx.eventId, customerId);
      const payment = await insertPayment(bookingId, `r-${bookingId}`, 'SUCCEEDED');
      const refund = (key: string, status: string) =>
        testDb.pool.query(
          `INSERT INTO refunds (booking_id, payment_id, amount_minor, currency, status, idempotency_key, processed_at)
           VALUES ($1, $2, 100000, 'BDT', $3::varchar, $4, CASE WHEN $3::varchar IN ('SUCCEEDED','FAILED') THEN now() END)`,
          [bookingId, payment.rows[0]!.id, status, key],
        );
      await refund(`rf-${bookingId}-1`, 'FAILED');
      await refund(`rf-${bookingId}-2`, 'PENDING');
      expect((await pgFailure(refund(`rf-${bookingId}-3`, 'PENDING'))).constraint).toBe(
        'uq_refunds_one_active_per_payment',
      );
    });

    it('deduplicates webhook deliveries and blocks processing unverified ones', async () => {
      const insert = (eventId: string, verified: boolean, status = 'PENDING') =>
        testDb.pool.query(
          `INSERT INTO payment_webhook_events (provider, provider_event_id, event_type, signature_verified, payload, processing_status)
           VALUES ('SSLCOMMERZ', $1, 'payment.validated', $2, '{}'::jsonb, $3)`,
          [eventId, verified, status],
        );
      const id = `evt-${fx.eventId}`;
      await insert(id, true);
      expect((await pgFailure(insert(id, true))).constraint).toBe('uq_webhook_provider_event');
      expect((await pgFailure(insert(`${id}-u`, false, 'PROCESSED'))).constraint).toBe(
        'chk_webhook_verified_before_processing',
      );
    });
  });

  describe('catalog and identity rules', () => {
    it('treats emails case-insensitively', async () => {
      await testDb.pool.query(
        `INSERT INTO users (name, email, password_hash) VALUES ('A', 'Case@Example.com', 'x')`,
      );
      const failure = await pgFailure(
        testDb.pool.query(
          `INSERT INTO users (name, email, password_hash) VALUES ('B', 'case@example.COM', 'x')`,
        ),
      );
      expect(failure.constraint).toBe('uq_users_email_lower');
    });

    it('validates early-bird configuration', async () => {
      const failure = await pgFailure(
        testDb.pool.query(
          `UPDATE events SET pricing_strategy = 'EARLY_BIRD', early_bird_discount_pct = 20, early_bird_deadline = NULL WHERE id = $1`,
          [fx.eventId],
        ),
      );
      expect(failure.constraint).toBe('chk_events_pricing_fields');
      await expect(
        testDb.pool.query(
          `UPDATE events SET pricing_strategy = 'EARLY_BIRD', early_bird_discount_pct = 20,
             early_bird_deadline = start_at - interval '1 day' WHERE id = $1`,
          [fx.eventId],
        ),
      ).resolves.toBeDefined();
    });

    it('rejects negative prices and duplicate category names per event', async () => {
      expect(
        (
          await pgFailure(
            testDb.pool.query(`UPDATE seat_categories SET price_minor = -1 WHERE id = $1`, [
              fx.categoryId,
            ]),
          )
        ).constraint,
      ).toBe('chk_seat_categories_price');
      expect(
        (
          await pgFailure(
            testDb.pool.query(
              `INSERT INTO seat_categories (event_id, name, price_minor) VALUES ($1, 'GENERAL', 1)`,
              [fx.eventId],
            ),
          )
        ).constraint,
      ).toBe('uq_seat_categories_event_name');
    });

    it('maintains updated_at automatically', async () => {
      const before = await testDb.pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM events WHERE id = $1',
        [fx.eventId],
      );
      await testDb.pool.query('SELECT pg_sleep(0.01)');
      await testDb.pool.query(`UPDATE events SET description = 'changed' WHERE id = $1`, [
        fx.eventId,
      ]);
      const after = await testDb.pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM events WHERE id = $1',
        [fx.eventId],
      );
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        before.rows[0]!.updated_at.getTime(),
      );
    });

    it('allows one notification per dedupe key (idempotent dispatch)', async () => {
      const insert = () =>
        testDb.pool.query(
          `INSERT INTO notifications (user_id, channel, type, title, message, dedupe_key)
           VALUES ($1, 'EMAIL', 'BOOKING_CONFIRMED', 't', 'm', $2)`,
          [customerId, `BOOKING_CONFIRMED:${customerId}:EMAIL`],
        );
      await insert();
      expect((await pgFailure(insert())).constraint).toBe('uq_notifications_dedupe_key');
    });
  });
});
