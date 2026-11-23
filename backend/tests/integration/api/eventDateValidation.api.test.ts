import request from 'supertest';
import { parseDateBoundary } from '../../../src/schemas/event.schemas';
import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';
import { setupPublishedEvent } from '../../helpers/bookingFixtures';

describe('Event search date validation', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
    await setupPublishedEvent(h, { startInDays: 30 });
  });

  afterAll(async () => {
    await h.close();
  });

  const search = (query: string) => request(h.app).get(`/api/events?${query}`);

  it.each([
    ['impossible month and day', 'from=2026-13-40'],
    ['February 30', 'from=2026-02-30'],
    ['non-leap February 29', 'from=2027-02-29'],
    ['malformed string', 'from=not-a-date'],
    ['loose format accepted by Date.parse', 'from=Jan%201%202027'],
    ['date with wrong separators', 'from=2027%2F01%2F01'],
    ['invalid to', 'to=2026-04-31'],
    ['impossible hour', 'from=2027-01-01T25:00:00Z'],
    ['date-time without a time zone', 'from=2027-01-01T10:00:00'],
    ['out-of-range offset', 'from=2027-01-01T10:00:00%2B15:00'],
  ])('rejects %s with HTTP 400', async (_name, query) => {
    const res = await search(query).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toMatch(/^query\.(from|to)$/);
  });

  it('rejects "from" after "to" with HTTP 400', async () => {
    const res = await search('from=2027-03-02&to=2027-03-01').expect(400);
    expect(res.body.error.details[0]).toMatchObject({
      path: 'query.to',
      message: '"from" must not be after "to"',
    });
  });

  it('accepts a valid leap day, a single-day range and an ISO date-time range', async () => {
    await search('from=2028-02-29').expect(200);
    await search('from=2027-01-01&to=2027-01-01').expect(200);
    await search('from=2027-01-01T00:00:00Z&to=2027-01-02T00:00:00%2B06:00').expect(200);
  });

  it('valid ranges still filter, and optional filters can be omitted', async () => {
    const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const inRange = await search(`from=${start}&to=${start}`).expect(200);
    expect(inRange.body.data).toHaveLength(1);
    const outOfRange = await search('from=2099-01-01').expect(200);
    expect(outOfRange.body.data).toHaveLength(0);
    const all = await search('').expect(200);
    expect(all.body.data.length).toBeGreaterThanOrEqual(1);
    expect(all.body.meta).toMatchObject({ page: 1 });
  });
});

describe('parseDateBoundary', () => {
  it('day boundaries are UTC midnights; "to" covers the whole day', () => {
    expect(parseDateBoundary('2027-01-31', false)?.toISOString()).toBe('2027-01-31T00:00:00.000Z');
    expect(parseDateBoundary('2027-01-31', true)?.toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(parseDateBoundary('2027-12-31', true)?.toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });

  it('date-times keep their exact instant and offset', () => {
    expect(parseDateBoundary('2027-01-01T06:30:00+06:00', false)?.toISOString()).toBe(
      '2027-01-01T00:30:00.000Z',
    );
    expect(parseDateBoundary('2027-01-01T06:30Z', true)?.toISOString()).toBe(
      '2027-01-01T06:30:00.000Z',
    );
  });

  it('never normalizes impossible values', () => {
    for (const value of ['2026-02-30', '2026-00-10', '2026-12-32', '1800-01-01', '2026-1-1', '']) {
      expect(parseDateBoundary(value, false)).toBeNull();
    }
  });
});
