import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { holdSeat, insertBooking } from '../../helpers/fixtures';
import { createApiHarness, signUp, type ApiHarness } from '../../helpers/apiHarness';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('Public event discovery', () => {
  let h: ApiHarness;
  let organizer: TestAgent;
  let customerId: string;
  const ids: Record<string, string> = {};
  const seatIds: string[] = [];

  async function venue(city: string, name: string): Promise<string> {
    const response = await organizer
      .post('/api/organizer/venues')
      .send({ name, address: '1 Main Road', city })
      .expect(201);
    return response.body.data.id as string;
  }

  async function event(
    key: string,
    venueId: string,
    title: string,
    startInDays: number,
    price: number,
    publish = true,
  ) {
    const response = await organizer
      .post('/api/organizer/events')
      .send({
        venueId,
        title,
        startAt: inDays(startInDays),
        pricing: { strategy: 'BASE' },
        seatMap: {
          rows: 1,
          seatsPerRow: 3,
          categories: [{ name: 'General', priceMinor: price, rows: ['A'] }],
        },
      })
      .expect(201);
    ids[key] = response.body.data.id as string;
    if (key === 'rock')
      seatIds.push(...(response.body.data.seats as { id: string }[]).map((s) => s.id));
    if (publish) await organizer.post(`/api/organizer/events/${ids[key]}/publish`).expect(200);
  }

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
    organizer = (await signUp(h, 'ORGANIZER')).agent;
    customerId = (await signUp(h, 'CUSTOMER')).userId;
    const dhaka = await venue('Dhaka', 'Dhaka Arena');
    const ctg = await venue('Chattogram', 'Port Hall');
    await event('rock', dhaka, 'Rock Night', 10, 150000);
    await event('jazz', ctg, 'Jazz_Evening 100%', 20, 90000);
    await event('tech', dhaka, 'Tech Summit', 40, 300000);
    await event('draft', dhaka, 'Secret Draft Show', 15, 1000, false);
    await event('past', dhaka, 'Old Concert', 5, 1000);
    await h.testDb.db.query(`UPDATE events SET start_at = now() - interval '1 day' WHERE id = $1`, [
      ids.past,
    ]);
  });

  afterAll(async () => {
    await h.close();
  });

  const titles = (response: request.Response) =>
    (response.body.data as { title: string }[]).map((e) => e.title);

  it('lists only published upcoming events without auth, soonest first', async () => {
    const response = await request(h.app).get('/api/events').expect(200);
    expect(titles(response)).toEqual(['Rock Night', 'Jazz_Evening 100%', 'Tech Summit']);
    expect(response.body.meta).toEqual({ page: 1, pageSize: 12, total: 3, totalPages: 1 });
  });

  it('never exposes organizer identity or lifecycle internals', async () => {
    const response = await request(h.app).get('/api/events').expect(200);
    const first = response.body.data[0] as Record<string, unknown>;
    expect(first).not.toHaveProperty('organizerId');
    expect(first).not.toHaveProperty('status');
    expect(first).toMatchObject({
      totalSeats: 3,
      availableSeats: 3,
      minPriceMinor: 150000,
      venue: { city: 'Dhaka' },
    });
  });

  it('searches by title or venue, matching wildcards literally', async () => {
    expect(titles(await request(h.app).get('/api/events?q=rock'))).toEqual(['Rock Night']);
    expect(titles(await request(h.app).get('/api/events?q=port hall'))).toEqual([
      'Jazz_Evening 100%',
    ]);
    expect(titles(await request(h.app).get('/api/events?q=100%25'))).toEqual(['Jazz_Evening 100%']);
    expect(titles(await request(h.app).get('/api/events?q=_'))).toEqual(['Jazz_Evening 100%']);
    expect(titles(await request(h.app).get('/api/events?q=secret'))).toEqual([]);
  });

  it('filters by city (case-insensitive) and date range', async () => {
    expect(titles(await request(h.app).get('/api/events?city=dhaka'))).toEqual([
      'Rock Night',
      'Tech Summit',
    ]);
    const from = inDays(15).slice(0, 10);
    const to = inDays(30).slice(0, 10);
    expect(titles(await request(h.app).get(`/api/events?from=${from}&to=${to}`))).toEqual([
      'Jazz_Evening 100%',
    ]);
    expect((await request(h.app).get('/api/events?from=2030-01-02&to=2030-01-01')).status).toBe(
      400,
    );
    expect((await request(h.app).get('/api/events?from=not-a-date')).status).toBe(400);
  });

  it('sorts and paginates', async () => {
    expect(titles(await request(h.app).get('/api/events?sort=price&order=desc'))).toEqual([
      'Tech Summit',
      'Rock Night',
      'Jazz_Evening 100%',
    ]);
    expect(titles(await request(h.app).get('/api/events?sort=title'))).toEqual([
      'Jazz_Evening 100%',
      'Rock Night',
      'Tech Summit',
    ]);
    const page2 = await request(h.app).get('/api/events?pageSize=2&page=2').expect(200);
    expect(titles(page2)).toEqual(['Tech Summit']);
    expect(page2.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect((await request(h.app).get('/api/events?pageSize=500')).status).toBe(400);
    expect((await request(h.app).get('/api/events?sort=organizer_id')).status).toBe(400);
  });

  it('lists cities with upcoming published events', async () => {
    expect((await request(h.app).get('/api/events/cities').expect(200)).body.data).toEqual([
      'Chattogram',
      'Dhaka',
    ]);
  });

  it('returns details with categories, and 404 for drafts or unknown ids', async () => {
    const details = await request(h.app).get(`/api/events/${ids.rock}`).expect(200);
    expect(details.body.data).toMatchObject({
      title: 'Rock Night',
      categories: [{ name: 'General', priceMinor: 150000, totalSeats: 3, availableSeats: 3 }],
    });
    expect((await request(h.app).get(`/api/events/${ids.draft}`)).status).toBe(404);
    expect(
      (await request(h.app).get('/api/events/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await request(h.app).get('/api/events/abc')).status).toBe(400);
  });

  it('reports seat availability without revealing who holds a seat', async () => {
    const bookingId = await insertBooking(h.testDb.db, ids.rock!, customerId);
    await holdSeat(h.testDb.db, bookingId, ids.rock!, seatIds[0]!);

    const seats = await request(h.app).get(`/api/events/${ids.rock}/seats`).expect(200);
    expect(seats.headers['cache-control']).toBe('no-store');
    const byId = new Map(
      (seats.body.data.seats as { id: string; status: string }[]).map((s) => [s.id, s]),
    );
    expect(byId.get(seatIds[0]!)).toMatchObject({ status: 'UNAVAILABLE', row: 'A', number: 1 });
    expect(byId.get(seatIds[1]!)!.status).toBe('AVAILABLE');
    expect(JSON.stringify(seats.body)).not.toContain(customerId);
    expect(seats.body.data.categories[0]).toMatchObject({ totalSeats: 3, availableSeats: 2 });

    // An expired hold frees the seat for display even before the expiry worker runs.
    await h.testDb.db.query(
      `UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
      [bookingId],
    );
    const after = await request(h.app).get(`/api/events/${ids.rock}/seats`).expect(200);
    expect(
      (after.body.data.seats as { id: string; status: string }[]).find((s) => s.id === seatIds[0])!
        .status,
    ).toBe('AVAILABLE');
    expect((await request(h.app).get(`/api/events/${ids.draft}/seats`)).status).toBe(404);
  });
});
