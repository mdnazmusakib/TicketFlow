import request from 'supertest';
import { createApiHarness, makeAdmin, signUp, type ApiHarness } from '../../helpers/apiHarness';
import { newCustomer, setupPublishedEvent } from '../../helpers/bookingFixtures';
import { idemKey, pay } from '../../helpers/paymentFixtures';

describe('Dashboards (customer, organizer, admin)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
  });

  afterAll(async () => {
    await h.close();
  });

  /** Organizer with one event: 2 confirmed seats (customer A), 1 held seat (customer B). */
  async function scenario() {
    const setup = await setupPublishedEvent(h, { startInDays: 20 });
    const a = await newCustomer(h);
    const held = await a.agent
      .post('/api/bookings')
      .send({ eventId: setup.eventId, seatIds: setup.rows.B!.slice(0, 2) })
      .expect(201);
    await pay(
      a.agent,
      held.body.data.id,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_success' },
      idemKey(),
    ).expect(201);
    const b = await newCustomer(h);
    await b.agent
      .post('/api/bookings')
      .send({ eventId: setup.eventId, seatIds: [setup.rows.A![0]] })
      .expect(201);
    await h.container.services.notifications.deliverDue(200);
    return { ...setup, a, b, confirmedId: held.body.data.id as string };
  }

  describe('customer', () => {
    it('returns profile, stats, upcoming bookings and recent notifications for the caller only', async () => {
      const { a, confirmedId } = await scenario();
      const res = await a.agent.get('/api/dashboard/customer').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.profile).toMatchObject({ id: a.userId, role: 'CUSTOMER' });
      expect(res.body.data.profile).not.toHaveProperty('passwordHash');
      expect(res.body.data.stats).toEqual({
        totalBookings: 1,
        upcomingBookings: 1,
        paidMinor: 200000,
        refundedMinor: 0,
        refundsInProgress: 0,
        netSpentMinor: 200000,
      });
      expect(res.body.data.upcoming).toEqual([
        expect.objectContaining({ bookingId: confirmedId, seatCount: 2, totalAmountMinor: 200000 }),
      ]);
      expect(res.body.data.recentNotifications).toEqual([
        expect.objectContaining({ type: 'BOOKING_CONFIRMED', bookingId: confirmedId }),
      ]);
      expect(res.body.data.unreadNotifications).toBe(1);

      const fresh = await newCustomer(h);
      const empty = await fresh.agent.get('/api/dashboard/customer').expect(200);
      expect(empty.body.data).toMatchObject({
        upcoming: [],
        recentNotifications: [],
        unreadNotifications: 0,
      });
      expect(empty.body.data.stats.totalBookings).toBe(0);
    });

    it('requires authentication', async () => {
      await request(h.app).get('/api/dashboard/customer').expect(401);
    });
  });

  describe('organizer', () => {
    it('summarises only the organizer’s own events with sales, pricing and booking statistics', async () => {
      const { organizer, eventId } = await scenario();
      const res = await organizer.get('/api/dashboard/organizer').expect(200);
      expect(res.body.data.totals).toMatchObject({
        events: 1,
        soldSeats: 2,
        heldSeats: 1,
        grossRevenueMinor: 200000,
        refundedMinor: 0,
        netRevenueMinor: 200000,
      });
      expect(res.body.data.eventsByStatus).toEqual({ PUBLISHED: 1 });
      expect(res.body.data.bookingsByStatus).toEqual({ CONFIRMED: 1, HELD: 1 });
      expect(res.body.data.upcomingEvents).toEqual([
        expect.objectContaining({
          eventId,
          totalSeats: 15,
          soldSeats: 2,
          heldSeats: 1,
          availableSeats: 12,
          occupancyPct: 13,
          pricing: expect.objectContaining({ strategy: 'BASE' }),
        }),
      ]);
    });

    it('event overview: category sales and attendee list with masked emails, filterable and paginated', async () => {
      const { organizer, eventId, confirmedId } = await scenario();
      const res = await organizer.get(`/api/dashboard/organizer/events/${eventId}`).expect(200);
      expect(res.body.data.event).toMatchObject({
        eventId,
        soldSeats: 2,
        grossRevenueMinor: 200000,
      });
      expect(res.body.data.categories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Regular' }),
          expect.objectContaining({ name: 'VIP' }),
        ]),
      );
      expect(res.body.data.bookingsByStatus).toEqual({ CONFIRMED: 1, HELD: 1 });
      expect(res.body.meta).toMatchObject({ total: 2, page: 1 });
      for (const booking of res.body.data.bookings) {
        expect(booking.customerEmail).toContain('*');
        expect(booking.customerEmail).not.toMatch(/customer\.\d+/);
      }
      const confirmed = await organizer
        .get(`/api/dashboard/organizer/events/${eventId}?status=CONFIRMED&pageSize=1`)
        .expect(200);
      expect(confirmed.body.data.bookings).toEqual([
        expect.objectContaining({
          bookingId: confirmedId,
          status: 'CONFIRMED',
          seatCount: 2,
          paymentProvider: 'MOCK_PROVIDER_B',
        }),
      ]);
      await organizer.get(`/api/dashboard/organizer/events/${eventId}?status=NOPE`).expect(400);
    });

    it('hides other organizers’ events (404) and blocks customers (403)', async () => {
      const { eventId, a } = await scenario();
      const { agent: otherOrganizer } = await signUp(h, 'ORGANIZER');
      await otherOrganizer.get(`/api/dashboard/organizer/events/${eventId}`).expect(404);
      const other = await otherOrganizer.get('/api/dashboard/organizer').expect(200);
      expect(other.body.data.totals.events).toBe(0);
      await a.agent.get('/api/dashboard/organizer').expect(403);
      await a.agent.get(`/api/dashboard/organizer/events/${eventId}`).expect(403);
    });
  });

  describe('admin', () => {
    it('platform overview and user directory are ADMIN only', async () => {
      const { a, organizer } = await scenario();
      await a.agent.get('/api/admin/overview').expect(403);
      await organizer.get('/api/admin/overview').expect(403);
      await a.agent.get('/api/admin/users').expect(403);
      await request(h.app).get('/api/admin/overview').expect(401);

      const admin = await signUp(h, 'CUSTOMER');
      await makeAdmin(h, admin.userId);
      // Role is read from the database on each request; sign in again to refresh the session.
      await admin.agent.post('/api/auth/logout');
      await admin.agent
        .post('/api/auth/login')
        .send({ email: admin.email, password: 'Str0ng!Passw0rd' })
        .expect(200);

      const overview = await admin.agent.get('/api/admin/overview').expect(200);
      expect(overview.body.data).toMatchObject({
        users: expect.objectContaining({ admins: 1 }),
        bookingsByStatus: expect.objectContaining({ CONFIRMED: expect.any(Number) }),
        notificationDelivery: expect.objectContaining({ SENT: expect.any(Number) }),
      });
      expect(overview.body.data.paidMinor).toBeGreaterThanOrEqual(200000);

      const organizers = await admin.agent
        .get('/api/admin/users?role=ORGANIZER&pageSize=2')
        .expect(200);
      expect(organizers.body.data.length).toBeLessThanOrEqual(2);
      expect(organizers.body.data.every((u: { role: string }) => u.role === 'ORGANIZER')).toBe(
        true,
      );
      expect(organizers.body.meta.total).toBeGreaterThanOrEqual(organizers.body.data.length);
      expect(organizers.body.data[0]).not.toHaveProperty('passwordHash');

      const found = await admin.agent.get('/api/admin/users?q=customer').expect(200);
      expect(found.body.data.length).toBeGreaterThan(0);
      // LIKE wildcards in the search are matched literally.
      const wildcard = await admin.agent.get('/api/admin/users?q=%25%25%25').expect(200);
      expect(wildcard.body.data).toEqual([]);

      // Admin sees every organizer's events on the organizer dashboard.
      const all = await admin.agent.get('/api/dashboard/organizer').expect(200);
      expect(all.body.data.totals.events).toBeGreaterThanOrEqual(1);
    });
  });
});
