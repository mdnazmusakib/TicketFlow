import request from 'supertest';
import { RedisKeys } from '../../../src/infrastructure/redis/keys';
import { createApiHarness, makeAdmin, signUp, type ApiHarness } from '../../helpers/apiHarness';
import { defineBookingConcurrencySuite } from '../../helpers/bookingConcurrencySuite';
import {
  activeAllocations,
  expireHoldNow,
  inDays,
  newCustomer,
  seatStates,
  setupPublishedEvent,
} from '../../helpers/bookingFixtures';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ otpBypass: true });
});

afterAll(async () => {
  await h.close();
});

describe('Booking API (real PostgreSQL)', () => {
  describe('quotes and pricing', () => {
    it('prices on the server with the base strategy', async () => {
      const { eventId, rows } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const quote = await agent
        .post('/api/bookings/quote')
        .send({ eventId, seatIds: [rows.A![0], rows.B![0]] })
        .expect(200);
      expect(quote.body.data).toMatchObject({
        currency: 'BDT',
        appliedStrategy: 'BASE',
        subtotalMinor: 300000,
        discountMinor: 0,
        totalMinor: 300000,
      });
    });

    it('applies the early-bird discount before the deadline and stores the snapshot', async () => {
      const { eventId, rows } = await setupPublishedEvent(h, {
        pricing: { strategy: 'EARLY_BIRD', earlyBirdDeadline: inDays(5), discountPct: 15 },
      });
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [rows.A![0], rows.B![0]] })
        .expect(201);
      expect(held.body.data).toMatchObject({
        status: 'HELD',
        pricingStrategy: 'EARLY_BIRD',
        totalAmountMinor: 170000 + 85000,
      });
      expect(
        (held.body.data.seats as { priceMinor: number }[])
          .map((s) => s.priceMinor)
          .sort((a, b) => a - b),
      ).toEqual([85000, 170000]);
    });

    it('ignores any client-sent price', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const response = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0]], totalMinor: 1 });
      expect(response.status).toBe(400); // unknown fields are rejected outright
    });
  });

  describe('hold lifecycle', () => {
    it('holds seats for 5 minutes, records history and sets Redis locks owned by the booking', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const before = Date.now();
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0], seatIds[1]] })
        .expect(201);
      const booking = held.body.data;

      expect(booking.status).toBe('HELD');
      const ttl = new Date(booking.holdExpiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(295_000);
      expect(ttl).toBeLessThan(305_000);
      expect(booking.history).toEqual([
        { from: null, to: 'HELD', reason: 'seat hold', at: expect.any(String) },
      ]);
      expect(await seatStates(h, booking.id)).toEqual(['HELD', 'HELD']);
      expect(await h.redis.get(RedisKeys.seatHold(eventId, seatIds[0]!))).toBe(booking.id);
      expect(await h.redis.pttl(RedisKeys.seatHold(eventId, seatIds[0]!))).toBeGreaterThan(200_000);

      // Public availability reflects the hold.
      const seats = await request(h.app).get(`/api/events/${eventId}/seats`).expect(200);
      const statusOf = (id: string) =>
        (seats.body.data.seats as { id: string; status: string }[]).find((s) => s.id === id)!
          .status;
      expect(statusOf(seatIds[0]!)).toBe('UNAVAILABLE');
      expect(statusOf(seatIds[2]!)).toBe('AVAILABLE');
    });

    it('moves HELD -> PENDING_PAYMENT on checkout, then can be cancelled, releasing seats and locks', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[2]] })
        .expect(201);
      const id = held.body.data.id as string;

      const pending = await agent.post(`/api/bookings/${id}/checkout`).expect(200);
      expect(pending.body.data.status).toBe('PENDING_PAYMENT');
      expect((await agent.post(`/api/bookings/${id}/checkout`)).status).toBe(409);

      const cancelled = await agent
        .post(`/api/bookings/${id}/cancel`)
        .send({ reason: 'Changed plans' })
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect(cancelled.body.data.holdExpiresAt).toBeNull();
      expect((cancelled.body.data.history as { to: string }[]).map((e) => e.to)).toEqual([
        'HELD',
        'PENDING_PAYMENT',
        'CANCELLED',
      ]);
      expect(await seatStates(h, id)).toEqual(['RELEASED']);
      expect(await h.redis.exists(RedisKeys.seatHold(eventId, seatIds[2]!))).toBe(0);
      expect((await agent.post(`/api/bookings/${id}/cancel`)).status).toBe(409);

      // Released seat is immediately bookable again.
      const other = await newCustomer(h);
      await other.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[2]] })
        .expect(201);
    });

    it('confirms PENDING_PAYMENT bookings (internal payment hook) and books the seats', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[3]] })
        .expect(201);
      const id = held.body.data.id as string;
      await expect(
        h.container.services.bookings.confirm(id, { reason: 'test' }),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      await agent.post(`/api/bookings/${id}/checkout`).expect(200);

      const confirmed = await h.container.services.bookings.confirm(id, {
        reason: 'payment verified',
      });
      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.confirmedAt).toEqual(expect.any(String));
      expect(await seatStates(h, id)).toEqual(['BOOKED']);
      expect(await h.redis.exists(RedisKeys.seatHold(eventId, seatIds[3]!))).toBe(0);
      expect((await agent.post(`/api/bookings/${id}/cancel`)).status).toBe(409);

      const taken = await (
        await newCustomer(h)
      ).agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[3]] });
      expect(taken.body.error.code).toBe('SEATS_UNAVAILABLE');
    });

    it('re-verifies the hold before confirming: an expired hold is never confirmed', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[4]] })
        .expect(201);
      const id = held.body.data.id as string;
      await agent.post(`/api/bookings/${id}/checkout`).expect(200);
      await expireHoldNow(h, id);
      await expect(
        h.container.services.bookings.confirm(id, { reason: 'late payment' }),
      ).rejects.toMatchObject({
        code: 'HOLD_EXPIRED',
      });
      const view = await agent.get(`/api/bookings/${id}`).expect(200);
      expect(view.body.data.status).toBe('EXPIRED');
      expect(await seatStates(h, id)).toEqual(['RELEASED']);
    });
  });

  describe('expiry', () => {
    it('worker expires due holds, releases seats and locks, and is idempotent', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[6], seatIds[7]] })
        .expect(201);
      const id = held.body.data.id as string;
      const fresh = await (
        await newCustomer(h)
      ).agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[8]] })
        .expect(201);
      await expireHoldNow(h, id);

      expect(await h.container.services.bookingExpiry.expireDue()).toBe(1);
      expect(await h.container.services.bookingExpiry.expireDue()).toBe(0);

      const view = await agent.get(`/api/bookings/${id}`).expect(200);
      expect(view.body.data.status).toBe('EXPIRED');
      expect(view.body.data.history.at(-1)).toMatchObject({
        from: 'HELD',
        to: 'EXPIRED',
        reason: 'hold expired',
      });
      expect(await seatStates(h, id)).toEqual(['RELEASED', 'RELEASED']);
      expect(await h.redis.exists(RedisKeys.seatHold(eventId, seatIds[6]!))).toBe(0);
      // Unexpired holds are untouched.
      expect((await agent.get(`/api/bookings/${fresh.body.data.id}`)).status).toBe(404); // not the owner
      expect(await seatStates(h, fresh.body.data.id)).toEqual(['HELD']);
    });

    it('checkout of an expired hold expires it and says so', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[9]] })
        .expect(201);
      await expireHoldNow(h, held.body.data.id);
      const response = await agent.post(`/api/bookings/${held.body.data.id}/checkout`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('HOLD_EXPIRED');
      expect(await seatStates(h, held.body.data.id)).toEqual(['RELEASED']);
    });

    it('new holds sweep expired holds on the same seats first', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const a = await newCustomer(h);
      const b = await newCustomer(h);
      const held = await a.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[10]] })
        .expect(201);
      await expireHoldNow(h, held.body.data.id);
      await b.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[10]] })
        .expect(201);
      const old = await a.agent.get(`/api/bookings/${held.body.data.id}`).expect(200);
      expect(old.body.data.status).toBe('EXPIRED');
    });

    it('the background worker runs on its own schedule', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[11]] })
        .expect(201);
      await expireHoldNow(h, held.body.data.id);
      await h.container.expiryWorker.tick();
      expect(await seatStates(h, held.body.data.id)).toEqual(['RELEASED']);
    });
  });

  describe('ticket limit', () => {
    it('allows up to 6 tickets per customer per event across bookings', async () => {
      const { eventId, rows } = await setupPublishedEvent(h, { rows: 2, seatsPerRow: 6 });
      const { agent } = await newCustomer(h);
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.A!.slice(0, 4) })
        .expect(201);
      const over = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.B!.slice(0, 3) });
      expect(over.status).toBe(409);
      expect(over.body.error).toMatchObject({
        code: 'TICKET_LIMIT_EXCEEDED',
        details: [{ path: 'seatIds', message: '2 more allowed' }],
      });
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.B!.slice(0, 2) })
        .expect(201);
      expect(
        (await agent.post('/api/bookings').send({ eventId, seatIds: [rows.B![5]] })).status,
      ).toBe(409);

      const tooMany = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.A!.concat(rows.B![5]!) });
      expect(tooMany.body.error.code).toBe('TICKET_LIMIT_EXCEEDED');
    });

    it('expired and cancelled bookings no longer count toward the limit', async () => {
      const { eventId, rows } = await setupPublishedEvent(h, { rows: 2, seatsPerRow: 6 });
      const { agent } = await newCustomer(h);
      const first = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.A! })
        .expect(201);
      await expireHoldNow(h, first.body.data.id);
      const second = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.B! })
        .expect(201);
      await agent.post(`/api/bookings/${second.body.data.id}/cancel`).expect(200);
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: rows.B!.slice(0, 6) })
        .expect(201);
    });
  });

  describe('validation, ownership and idempotency', () => {
    it('rejects unknown seats, seats from another event, and events not on sale', async () => {
      const one = await setupPublishedEvent(h);
      const two = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      expect(
        (
          await agent
            .post('/api/bookings')
            .send({ eventId: one.eventId, seatIds: [two.seatIds[0]] })
        ).status,
      ).toBe(404);
      expect(
        (await agent.post('/api/bookings').send({ eventId: one.eventId, seatIds: [] })).status,
      ).toBe(400);
      expect(
        (await agent.post('/api/bookings').send({ eventId: one.eventId, seatIds: ['nope'] }))
          .status,
      ).toBe(400);

      await one.organizer.post(`/api/organizer/events/${one.eventId}/unpublish`).expect(200);
      expect(
        (
          await agent
            .post('/api/bookings')
            .send({ eventId: one.eventId, seatIds: [one.seatIds[0]] })
        ).status,
      ).toBe(404);

      await h.testDb.db.query(
        `UPDATE events SET sales_end_at = now() - interval '1 minute' WHERE id = $1`,
        [two.eventId],
      );
      const closed = await agent
        .post('/api/bookings')
        .send({ eventId: two.eventId, seatIds: [two.seatIds[0]] });
      expect(closed.body.error.code).toBe('EVENT_NOT_ON_SALE');
    });

    it('only customers can hold seats', async () => {
      const { eventId, seatIds, organizer } = await setupPublishedEvent(h);
      expect(
        (await organizer.post('/api/bookings').send({ eventId, seatIds: [seatIds[0]] })).status,
      ).toBe(403);
      expect(
        (
          await request(h.app)
            .post('/api/bookings')
            .send({ eventId, seatIds: [seatIds[0]] })
        ).status,
      ).toBe(401);
    });

    it("hides other customers' bookings (IDOR -> 404) but lets ADMIN view them", async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const owner = await newCustomer(h);
      const other = await newCustomer(h);
      const held = await owner.agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[12]] })
        .expect(201);
      const id = held.body.data.id as string;

      expect((await other.agent.get(`/api/bookings/${id}`)).status).toBe(404);
      expect((await other.agent.post(`/api/bookings/${id}/checkout`)).status).toBe(404);
      expect((await other.agent.post(`/api/bookings/${id}/cancel`)).status).toBe(404);
      const list = await other.agent.get('/api/bookings').expect(200);
      expect(list.body.data).toEqual([]);

      const admin = await signUp(h, 'CUSTOMER');
      await makeAdmin(h, admin.userId);
      await admin.agent.get(`/api/bookings/${id}`).expect(200);
      expect(await seatStates(h, id)).toEqual(['HELD']);
    });

    it('lists my bookings with pagination and status filter', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const a = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[13]] })
        .expect(201);
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[14]] })
        .expect(201);
      await agent.post(`/api/bookings/${a.body.data.id}/cancel`).expect(200);

      const all = await agent.get('/api/bookings?pageSize=1').expect(200);
      expect(all.body.meta).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
      const cancelled = await agent.get('/api/bookings?status=CANCELLED').expect(200);
      expect(cancelled.body.data).toHaveLength(1);
      expect(cancelled.body.data[0]).toMatchObject({
        status: 'CANCELLED',
        seatCount: 1,
        event: { title: 'Booking Test Event' },
      });
    });

    it('replays a hold with the same Idempotency-Key instead of creating a second one', async () => {
      const { eventId, seatIds } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      const key = 'retry-key-12345';
      const [first, second] = await Promise.all([
        agent
          .post('/api/bookings')
          .set('Idempotency-Key', key)
          .send({ eventId, seatIds: [seatIds[0]] }),
        agent
          .post('/api/bookings')
          .set('Idempotency-Key', key)
          .send({ eventId, seatIds: [seatIds[0]] }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(first.body.data.id).toBe(second.body.data.id);
      expect(await activeAllocations(h, eventId)).toBe(1);
      expect(
        (
          await agent
            .post('/api/bookings')
            .set('Idempotency-Key', 'bad')
            .send({ eventId, seatIds: [seatIds[1]] })
        ).status,
      ).toBe(400);
    });

    it('organizer edits wait for / are blocked by active holds', async () => {
      const { eventId, seatIds, organizer } = await setupPublishedEvent(h);
      const { agent } = await newCustomer(h);
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0]] })
        .expect(201);
      const reschedule = await organizer
        .patch(`/api/organizer/events/${eventId}`)
        .send({ startAt: inDays(40) });
      expect(reschedule.body.error.code).toBe('ACTIVE_BOOKINGS_EXIST');
    });
  });
});

defineBookingConcurrencySuite('PostgreSQL + in-memory Redis', () => h);
