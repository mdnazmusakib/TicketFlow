import { RedisKeys } from '../../src/infrastructure/redis/keys';
import { BookingRepository } from '../../src/repositories/BookingRepository';
import type { ApiHarness } from './apiHarness';
import {
  activeAllocations,
  expireHoldNow,
  newCustomer,
  seatStates,
  setupPublishedEvent,
} from './bookingFixtures';

/**
 * Concurrency scenarios shared by two Jest projects:
 * - integration: real PostgreSQL + in-memory Redis (always runs);
 * - concurrency: real PostgreSQL + a real Redis server (`npm run test:concurrency`).
 * Every request goes through the HTTP API and real transactions.
 */
export function defineBookingConcurrencySuite(label: string, getHarness: () => ApiHarness): void {
  describe(`booking concurrency (${label})`, () => {
    const h = () => getHarness();

    it('20 customers race for the same seat: exactly one wins, the rest get 409', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h());
      const customers = await Promise.all(Array.from({ length: 20 }, () => newCustomer(h())));

      const responses = await Promise.all(
        customers.map(({ agent }) =>
          agent.post('/api/bookings').send({ eventId, seatIds: [seatIds[0]] }),
        ),
      );

      const winners = responses.filter((r) => r.status === 201);
      const losers = responses.filter((r) => r.status === 409);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(19);
      expect(losers.every((r) => r.body.error.code === 'SEATS_UNAVAILABLE')).toBe(true);
      expect(await activeAllocations(h(), eventId)).toBe(1);
    });

    it('overlapping multi-seat requests never share a seat', async () => {
      const { eventId, rows } = await setupPublishedEvent(h());
      const rowB = rows.B!;
      // Each request wants two adjacent seats; neighbours overlap by one seat.
      const requests = [0, 1, 2, 3].map((i) => [rowB[i]!, rowB[i + 1]!]);
      const customers = await Promise.all(requests.map(() => newCustomer(h())));

      const responses = await Promise.all(
        customers.map(({ agent }, i) =>
          agent.post('/api/bookings').send({ eventId, seatIds: requests[i] }),
        ),
      );
      const held = responses
        .filter((r) => r.status === 201)
        .flatMap((r) => (r.body.data.seats as { seatId: string }[]).map((s) => s.seatId));
      expect(new Set(held).size).toBe(held.length);
      expect(held.length).toBeGreaterThanOrEqual(2); // at least one 2-seat hold succeeded
      expect(await activeAllocations(h(), eventId)).toBe(held.length);
    });

    it('one customer firing 10 parallel holds cannot exceed the 6-ticket limit', async () => {
      const { eventId, rows } = await setupPublishedEvent(h(), { rows: 4, seatsPerRow: 5 });
      const { agent, userId } = await newCustomer(h());
      const pairs = [
        [rows.B![0], rows.B![1]],
        [rows.B![2], rows.B![3]],
        [rows.C![0], rows.C![1]],
        [rows.C![2], rows.C![3]],
        [rows.D![0], rows.D![1]],
        [rows.D![2], rows.D![3]],
        [rows.B![4], rows.C![4]],
        [rows.D![4], rows.A![0]],
        [rows.A![1], rows.A![2]],
        [rows.A![3], rows.A![4]],
      ];

      const responses = await Promise.all(
        pairs.map((seatIds) => agent.post('/api/bookings').send({ eventId, seatIds })),
      );
      const ok = responses.filter((r) => r.status === 201);
      expect(ok).toHaveLength(3); // 3 x 2 seats = 6
      expect(
        responses
          .filter((r) => r.status === 409)
          .every((r) => r.body.error.code === 'TICKET_LIMIT_EXCEEDED'),
      ).toBe(true);

      const repo = new BookingRepository(h().testDb.db);
      expect(
        await h().testDb.db.withTransaction((tx) => repo.countActiveSeats(tx, userId, eventId)),
      ).toBe(6);
    });

    it('rolls back and releases Redis locks when the transaction fails mid-way', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h());
      const { agent } = await newCustomer(h());
      const repoPrototype = BookingRepository.prototype;
      const spy = jest
        .spyOn(repoPrototype, 'insertBookingSeats')
        .mockRejectedValueOnce(new Error('simulated database failure'));

      const failed = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0], seatIds[1]] });
      spy.mockRestore();
      expect(failed.status).toBe(500);

      const { rows } = await h().testDb.db.query(
        'SELECT count(*)::int AS n FROM bookings WHERE event_id = $1',
        [eventId],
      );
      expect(rows[0]?.n).toBe(0); // booking row rolled back with the failed seat insert
      expect(await h().redis.exists(RedisKeys.seatHold(eventId, seatIds[0]!))).toBe(0);
      expect(await h().redis.exists(RedisKeys.seatHold(eventId, seatIds[1]!))).toBe(0);

      // The same seats can be held immediately afterwards.
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0], seatIds[1]] })
        .expect(201);
    });

    it('PostgreSQL still prevents double booking when Redis locks are bypassed', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h());
      const a = await newCustomer(h());
      const b = await newCustomer(h());
      await a.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[3]] })
        .expect(201);
      // Simulate a lost/expired Redis lock (e.g. Redis restart) while the DB hold is active.
      await h().redis.del(RedisKeys.seatHold(eventId, seatIds[3]!));

      const second = await b.agent.post('/api/bookings').send({ eventId, seatIds: [seatIds[3]] });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SEATS_UNAVAILABLE');
      expect(await activeAllocations(h(), eventId)).toBe(1);
    });

    it('reclaims stale Redis locks left by cancelled bookings', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h());
      const a = await newCustomer(h());
      const b = await newCustomer(h());
      const held = await a.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[4]] })
        .expect(201);
      const bookingId = held.body.data.id as string;
      // Simulate a missed lock release: cancel in the DB but leave the Redis key behind.
      await h().testDb.db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE bookings SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`,
          [bookingId],
        );
        await tx.query(
          `UPDATE booking_seats SET seat_state = 'RELEASED', released_at = now() WHERE booking_id = $1`,
          [bookingId],
        );
      });
      expect(await h().redis.get(RedisKeys.seatHold(eventId, seatIds[4]!))).toBe(bookingId);

      await b.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[4]] })
        .expect(201);
    });

    it('expiry worker and checkout racing on the same hold resolve to one consistent state', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h());
      const { agent } = await newCustomer(h());
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[5]] })
        .expect(201);
      const bookingId = held.body.data.id as string;
      await expireHoldNow(h(), bookingId);

      const [checkout] = await Promise.all([
        agent.post(`/api/bookings/${bookingId}/checkout`),
        h().container.services.bookingExpiry.expireDue(),
      ]);
      expect(checkout.status).toBe(409);
      expect(['HOLD_EXPIRED', 'INVALID_STATE_TRANSITION']).toContain(checkout.body.error.code);

      const { rows } = await h().testDb.db.query<{ status: string }>(
        'SELECT status FROM bookings WHERE id = $1',
        [bookingId],
      );
      expect(rows[0]!.status).toBe('EXPIRED');
      expect(await seatStates(h(), bookingId)).toEqual(['RELEASED']);
      const history = await h().testDb.db.query(
        `SELECT count(*)::int AS n FROM booking_status_history WHERE booking_id = $1 AND to_status = 'EXPIRED'`,
        [bookingId],
      );
      expect(history.rows[0]?.n).toBe(1); // expired exactly once
      expect(await h().redis.exists(RedisKeys.seatHold(eventId, seatIds[5]!))).toBe(0);
    });

    it('parallel expiry workers process each booking exactly once', async () => {
      const { eventId, rows } = await setupPublishedEvent(h());
      const customers = await Promise.all([0, 1, 2, 3, 4].map(() => newCustomer(h())));
      const ids: string[] = [];
      for (const [i, { agent }] of customers.entries()) {
        const res = await agent
          .post('/api/bookings')
          .send({ eventId, seatIds: [rows.C![i]] })
          .expect(201);
        ids.push(res.body.data.id as string);
      }
      for (const id of ids) await expireHoldNow(h(), id);

      const counts = await Promise.all(
        [0, 1, 2].map(() => h().container.services.bookingExpiry.expireDue(2)),
      );
      expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
      const history = await h().testDb.db.query(
        `SELECT count(*)::int AS n FROM booking_status_history WHERE booking_id = ANY($1) AND to_status = 'EXPIRED'`,
        [ids],
      );
      expect(history.rows[0]?.n).toBe(5);
      expect(await activeAllocations(h(), eventId)).toBe(0);
    });
  });
}
