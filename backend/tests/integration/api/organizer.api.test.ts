import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { holdSeat, insertBooking } from '../../helpers/fixtures';
import { createApiHarness, makeAdmin, signUp, type ApiHarness } from '../../helpers/apiHarness';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const venueBody = { name: 'Harbour Hall', address: '1 Port Road', city: 'Chattogram' };

function eventBody(venueId: string, overrides: Record<string, unknown> = {}) {
  return {
    venueId,
    title: 'Integration Fest',
    description: 'Live music',
    startAt: inDays(30),
    endAt: inDays(30.2),
    pricing: { strategy: 'EARLY_BIRD', earlyBirdDeadline: inDays(10), discountPct: 15 },
    seatMap: {
      rows: 3,
      seatsPerRow: 4,
      categories: [
        { name: 'VIP', priceMinor: 250000, rows: ['A'] },
        { name: 'Regular', priceMinor: 100000, rows: ['B', 'C'] },
      ],
    },
    ...overrides,
  };
}

describe('Organizer API: authorization, ownership and CRUD', () => {
  let h: ApiHarness;
  let orgA: TestAgent;
  let orgB: TestAgent;
  let customer: TestAgent;
  let customerId: string;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
    orgA = (await signUp(h, 'ORGANIZER')).agent;
    orgB = (await signUp(h, 'ORGANIZER')).agent;
    const c = await signUp(h, 'CUSTOMER');
    customer = c.agent;
    customerId = c.userId;
  });

  afterAll(async () => {
    await h.close();
  });

  async function createVenue(
    agent: TestAgent,
    body: Record<string, unknown> = venueBody,
  ): Promise<string> {
    const response = await agent
      .post('/api/organizer/venues')
      .send({ ...body, name: `${String(body.name)} ${Math.random()}` })
      .expect(201);
    return response.body.data.id as string;
  }

  async function createEvent(
    agent: TestAgent,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; body: Record<string, unknown> }> {
    const venueId = await createVenue(agent);
    const response = await agent
      .post('/api/organizer/events')
      .send(eventBody(venueId, overrides))
      .expect(201);
    return { id: response.body.data.id as string, body: response.body.data };
  }

  describe('role-based access', () => {
    it('requires authentication', async () => {
      expect((await request(h.app).get('/api/organizer/events')).status).toBe(401);
      expect((await request(h.app).post('/api/organizer/venues').send(venueBody)).status).toBe(401);
    });

    it('forbids customers from organizer routes', async () => {
      const response = await customer.get('/api/organizer/events');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect((await customer.post('/api/organizer/venues').send(venueBody)).status).toBe(403);
    });
  });

  describe('venues', () => {
    it('creates, lists, updates and deletes own venues', async () => {
      const created = await orgA
        .post('/api/organizer/venues')
        .send({ ...venueBody, name: 'Own Venue', countryCode: 'bd' })
        .expect(201);
      expect(created.body.data).toMatchObject({
        name: 'Own Venue',
        countryCode: 'BD',
        timezone: 'Asia/Dhaka',
      });
      const id = created.body.data.id as string;

      const list = await orgA.get('/api/organizer/venues').expect(200);
      expect((list.body.data as { id: string }[]).some((v) => v.id === id)).toBe(true);

      const updated = await orgA
        .patch(`/api/organizer/venues/${id}`)
        .send({ city: 'Sylhet' })
        .expect(200);
      expect(updated.body.data.city).toBe('Sylhet');

      await orgA.delete(`/api/organizer/venues/${id}`).expect(204);
      await orgA.get(`/api/organizer/venues/${id}`).expect(404);
    });

    it("hides other organizers' venues (IDOR answers 404)", async () => {
      const id = await createVenue(orgA);
      expect((await orgB.get(`/api/organizer/venues/${id}`)).status).toBe(404);
      expect(
        (await orgB.patch(`/api/organizer/venues/${id}`).send({ city: 'X City' })).status,
      ).toBe(404);
      expect((await orgB.delete(`/api/organizer/venues/${id}`)).status).toBe(404);
      const listB = await orgB.get('/api/organizer/venues').expect(200);
      expect((listB.body.data as { id: string }[]).some((v) => v.id === id)).toBe(false);
      await orgA.get(`/api/organizer/venues/${id}`).expect(200);
    });

    it('validates input and refuses to delete venues in use', async () => {
      const bad = await orgA
        .post('/api/organizer/venues')
        .send({ name: 'X', address: '', city: 'Y', timezone: 'Mars/Base' });
      expect(bad.status).toBe(400);
      const { body } = await createEvent(orgA);
      const venueId = (body.venue as { id: string }).id;
      const inUse = await orgA.delete(`/api/organizer/venues/${venueId}`);
      expect(inUse.status).toBe(409);
      expect(inUse.body.error.code).toBe('RESOURCE_IN_USE');
    });

    it('rejects malformed ids', async () => {
      expect((await orgA.get('/api/organizer/venues/not-a-uuid')).status).toBe(400);
    });
  });

  describe('events', () => {
    it('creates a draft with its generated seat map and pricing config', async () => {
      const { body } = await createEvent(orgA);
      expect(body).toMatchObject({
        status: 'DRAFT',
        title: 'Integration Fest',
        currency: 'BDT',
        pricing: { strategy: 'EARLY_BIRD', earlyBirdDiscountPct: 15, earlyBirdActive: true },
        seatMap: { rows: 3, seatsPerRow: 4 },
        totalSeats: 12,
        availableSeats: 12,
        minPriceMinor: 100000,
        maxPriceMinor: 250000,
      });
      const categories = body.categories as { name: string; totalSeats: number }[];
      expect(categories.map((c) => [c.name, c.totalSeats])).toEqual([
        ['VIP', 4],
        ['Regular', 8],
      ]);
      expect((body.seats as unknown[]).length).toBe(12);
    });

    it('validates schedule, pricing and seat map coverage', async () => {
      const venueId = await createVenue(orgA);
      const past = await orgA
        .post('/api/organizer/events')
        .send(eventBody(venueId, { startAt: inDays(-1) }));
      expect(past.status).toBe(400);

      const deadlineAfterStart = await orgA.post('/api/organizer/events').send(
        eventBody(venueId, {
          pricing: { strategy: 'EARLY_BIRD', earlyBirdDeadline: inDays(40), discountPct: 10 },
        }),
      );
      expect(deadlineAfterStart.status).toBe(400);

      const uncovered = await orgA.post('/api/organizer/events').send(
        eventBody(venueId, {
          seatMap: {
            rows: 3,
            seatsPerRow: 2,
            categories: [{ name: 'All', priceMinor: 1, rows: ['A', 'B'] }],
          },
        }),
      );
      expect(uncovered.status).toBe(400);
      expect(JSON.stringify(uncovered.body.error.details)).toContain('rows without a category: C');

      const fractional = await orgA.post('/api/organizer/events').send(
        eventBody(venueId, {
          seatMap: {
            rows: 1,
            seatsPerRow: 2,
            categories: [{ name: 'All', priceMinor: 10.5, rows: ['A'] }],
          },
        }),
      );
      expect(fractional.status).toBe(400);
    });

    it("cannot use another organizer's venue", async () => {
      const foreignVenue = await createVenue(orgB);
      const response = await orgA.post('/api/organizer/events').send(eventBody(foreignVenue));
      expect(response.status).toBe(404);
    });

    it("hides other organizers' events for every action (IDOR)", async () => {
      const { id } = await createEvent(orgA);
      expect((await orgB.get(`/api/organizer/events/${id}`)).status).toBe(404);
      expect(
        (await orgB.patch(`/api/organizer/events/${id}`).send({ title: 'Hijacked title' })).status,
      ).toBe(404);
      expect((await orgB.post(`/api/organizer/events/${id}/publish`)).status).toBe(404);
      expect((await orgB.post(`/api/organizer/events/${id}/cancel`)).status).toBe(404);
      expect((await orgB.delete(`/api/organizer/events/${id}`)).status).toBe(404);
      expect(
        (
          await orgB.put(`/api/organizer/events/${id}/seat-map`).send({
            rows: 1,
            seatsPerRow: 1,
            categories: [{ name: 'X', priceMinor: 1, rows: ['A'] }],
          })
        ).status,
      ).toBe(404);
      const listB = await orgB.get('/api/organizer/events').expect(200);
      expect((listB.body.data as { id: string }[]).some((e) => e.id === id)).toBe(false);

      const still = await orgA.get(`/api/organizer/events/${id}`).expect(200);
      expect(still.body.data.title).toBe('Integration Fest');
    });

    it('lets ADMIN manage any event but not create one', async () => {
      const admin = await signUp(h, 'CUSTOMER');
      await makeAdmin(h, admin.userId);
      const { id } = await createEvent(orgA);
      await admin.agent.get(`/api/organizer/events/${id}`).expect(200);
      await admin.agent
        .patch(`/api/organizer/events/${id}`)
        .send({ title: 'Admin edited' })
        .expect(200);
      const venueId = await createVenue(orgA);
      expect(
        (await admin.agent.post('/api/organizer/events').send(eventBody(venueId))).status,
      ).toBe(403);
    });

    it('updates metadata, publishes, unpublishes, cancels and deletes', async () => {
      const { id } = await createEvent(orgA);
      const updated = await orgA
        .patch(`/api/organizer/events/${id}`)
        .send({ title: 'Renamed Fest', pricing: { strategy: 'BASE' }, description: null })
        .expect(200);
      expect(updated.body.data).toMatchObject({
        title: 'Renamed Fest',
        description: null,
        pricing: { strategy: 'BASE' },
      });

      const published = await orgA.post(`/api/organizer/events/${id}/publish`).expect(200);
      expect(published.body.data.status).toBe('PUBLISHED');
      expect(published.body.data.publishedAt).toEqual(expect.any(String));
      expect((await orgA.post(`/api/organizer/events/${id}/publish`)).status).toBe(409);
      expect((await orgA.delete(`/api/organizer/events/${id}`)).status).toBe(409);

      await orgA.post(`/api/organizer/events/${id}/unpublish`).expect(200);
      const cancelled = await orgA.post(`/api/organizer/events/${id}/cancel`).expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect(
        (await orgA.patch(`/api/organizer/events/${id}`).send({ title: 'Too late now' })).status,
      ).toBe(409);
      await orgA.delete(`/api/organizer/events/${id}`).expect(204);
      await orgA.get(`/api/organizer/events/${id}`).expect(404);
    });

    it('replaces the seat map, renames categories and reassigns seats', async () => {
      const { id } = await createEvent(orgA);
      const replaced = await orgA
        .put(`/api/organizer/events/${id}/seat-map`)
        .send({
          rows: 2,
          seatsPerRow: 5,
          categories: [{ name: 'General', priceMinor: 50000, rows: ['A', 'B'] }],
        })
        .expect(200);
      expect(replaced.body.data).toMatchObject({
        seatMap: { rows: 2, seatsPerRow: 5 },
        totalSeats: 10,
      });

      const replacedAgain = await orgA
        .put(`/api/organizer/events/${id}/seat-map`)
        .send({
          rows: 2,
          seatsPerRow: 2,
          categories: [
            { name: 'Front', priceMinor: 90000, rows: ['A'] },
            { name: 'Back', priceMinor: 40000, rows: ['B'] },
          ],
        })
        .expect(200);
      const categories = replacedAgain.body.data.categories as { id: string; name: string }[];
      const front = categories.find((c) => c.name === 'Front')!;
      const back = categories.find((c) => c.name === 'Back')!;

      const renamed = await orgA
        .patch(`/api/organizer/events/${id}/categories/${front.id}`)
        .send({ name: 'Premium', priceMinor: 120000 })
        .expect(200);
      expect(
        (renamed.body.data.categories as { name: string; priceMinor: number }[])[0],
      ).toMatchObject({
        name: 'Premium',
        priceMinor: 120000,
      });

      const backSeat = (replacedAgain.body.data.seats as { id: string; categoryId: string }[]).find(
        (s) => s.categoryId === back.id,
      )!;
      const reassigned = await orgA
        .patch(`/api/organizer/events/${id}/seats/category`)
        .send({ seatIds: [backSeat.id], categoryId: front.id })
        .expect(200);
      const seat = (reassigned.body.data.seats as { id: string; categoryId: string }[]).find(
        (s) => s.id === backSeat.id,
      )!;
      expect(seat.categoryId).toBe(front.id);

      const foreignCategory = await orgA
        .patch(`/api/organizer/events/${id}/seats/category`)
        .send({ seatIds: [backSeat.id], categoryId: '00000000-0000-4000-8000-000000000000' });
      expect(foreignCategory.status).toBe(404);
    });

    it('blocks destructive changes while bookings are active', async () => {
      const { id, body } = await createEvent(orgA);
      await orgA.post(`/api/organizer/events/${id}/publish`).expect(200);
      const seatId = (body.seats as { id: string }[])[0]!.id;
      const bookingId = await insertBooking(h.testDb.db, id, customerId);
      await holdSeat(h.testDb.db, bookingId, id, seatId);

      const reschedule = await orgA
        .patch(`/api/organizer/events/${id}`)
        .send({ startAt: inDays(45) });
      expect(reschedule.status).toBe(409);
      expect(reschedule.body.error.code).toBe('ACTIVE_BOOKINGS_EXIST');

      const otherVenue = await createVenue(orgA);
      expect(
        (await orgA.patch(`/api/organizer/events/${id}`).send({ venueId: otherVenue })).status,
      ).toBe(409);
      expect(
        (
          await orgA.put(`/api/organizer/events/${id}/seat-map`).send({
            rows: 1,
            seatsPerRow: 1,
            categories: [{ name: 'X', priceMinor: 1, rows: ['A'] }],
          })
        ).status,
      ).toBe(409);
      expect((await orgA.post(`/api/organizer/events/${id}/unpublish`)).status).toBe(409);
      expect((await orgA.post(`/api/organizer/events/${id}/cancel`)).status).toBe(409);

      const categories = body.categories as { id: string }[];
      const heldSeatMove = await orgA
        .patch(`/api/organizer/events/${id}/seats/category`)
        .send({ seatIds: [seatId], categoryId: categories[1]!.id });
      expect(heldSeatMove.status).toBe(409);

      // Safe edits remain possible: bookings keep their price snapshot.
      await orgA
        .patch(`/api/organizer/events/${id}`)
        .send({ title: 'Still editable title' })
        .expect(200);
      await orgA
        .patch(`/api/organizer/events/${id}/categories/${categories[0]!.id}`)
        .send({ priceMinor: 1 })
        .expect(200);

      // Once the hold expires the event is no longer locked by it.
      await h.testDb.db.query(
        `UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [bookingId],
      );
      await orgA
        .patch(`/api/organizer/events/${id}`)
        .send({ startAt: inDays(45), endAt: null })
        .expect(200);
      // ...but the seat map stays frozen because booking history exists.
      expect(
        (
          await orgA.put(`/api/organizer/events/${id}/seat-map`).send({
            rows: 1,
            seatsPerRow: 1,
            categories: [{ name: 'X', priceMinor: 1, rows: ['A'] }],
          })
        ).status,
      ).toBe(409);
    });

    it('paginates and filters the organizer list by status', async () => {
      const own = await signUp(h, 'ORGANIZER');
      for (let i = 0; i < 3; i += 1) await createEvent(own.agent);
      const page = await own.agent.get('/api/organizer/events?pageSize=2&page=1').expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      const published = await own.agent.get('/api/organizer/events?status=PUBLISHED').expect(200);
      expect(published.body.data).toHaveLength(0);
    });
  });
});
