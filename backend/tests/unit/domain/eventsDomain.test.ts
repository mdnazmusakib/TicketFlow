import { isEditableStatus, validateSchedule } from '../../../src/domain/events/eventRules';
import { generateSeats, rowLabels, validateSeatMap } from '../../../src/domain/events/seatMap';
import { passwordSchema, registerSchema } from '../../../src/schemas/auth.schemas';
import {
  createEventSchema,
  publicEventQuerySchema,
  venueSchema,
} from '../../../src/schemas/event.schemas';

const now = new Date('2026-06-01T00:00:00Z');
const day = 86_400_000;
const at = (days: number) => new Date(now.getTime() + days * day);

describe('seat map rules', () => {
  const map = {
    rows: 3,
    seatsPerRow: 2,
    categories: [
      { name: 'VIP', priceMinor: 100, rows: ['A'] },
      { name: 'Std', priceMinor: 50, rows: ['B', 'C'] },
    ],
  };

  it('accepts a fully covered map and generates rows x seats', () => {
    expect(validateSeatMap(map)).toEqual([]);
    const seats = generateSeats(map);
    expect(seats).toHaveLength(6);
    expect(seats[0]).toEqual({ rowLabel: 'A', seatNumber: 1, categoryName: 'VIP' });
    expect(seats.at(-1)).toEqual({ rowLabel: 'C', seatNumber: 2, categoryName: 'Std' });
    expect(rowLabels(28).slice(-2)).toEqual(['AA', 'AB']);
  });

  it('reports overlaps, gaps, unknown rows, duplicates and bounds', () => {
    expect(
      validateSeatMap({
        rows: 2,
        seatsPerRow: 1,
        categories: [
          { name: 'X', priceMinor: 1, rows: ['A', 'Z'] },
          { name: 'x', priceMinor: 1, rows: ['A'] },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'duplicate category name "x"',
        'row Z does not exist in a 2-row map',
        'row A is assigned to more than one category',
        'rows without a category: B',
      ]),
    );
    expect(validateSeatMap({ rows: 0, seatsPerRow: 101, categories: [] })).toHaveLength(3);
    expect(() =>
      generateSeats({
        rows: 2,
        seatsPerRow: 1,
        categories: [{ name: 'A', priceMinor: 1, rows: ['A'] }],
      }),
    ).toThrow('Row B has no category');
  });
});

describe('event schedule rules', () => {
  const base = {
    startAt: at(10),
    endAt: at(10.1),
    salesStartAt: null,
    salesEndAt: null,
    pricing: { strategy: 'BASE' as const },
  };

  it('accepts a valid future schedule', () => {
    expect(validateSchedule(base, now)).toEqual([]);
  });

  it('rejects past starts, inverted windows and bad early-bird config', () => {
    expect(
      validateSchedule(
        {
          startAt: at(-1),
          endAt: at(-2),
          salesStartAt: at(5),
          salesEndAt: at(4),
          pricing: { strategy: 'EARLY_BIRD', earlyBirdDeadline: at(1), discountPct: 0 },
        },
        now,
      ),
    ).toEqual(
      expect.arrayContaining([
        'startAt must be in the future',
        'endAt must be after startAt',
        'salesStartAt must be before salesEndAt',
        'salesEndAt must not be after startAt',
        'earlyBirdDeadline must not be after startAt',
        'discountPct must be between 1 and 99',
      ]),
    );
  });

  it('only drafts and published events are editable', () => {
    expect(isEditableStatus('DRAFT')).toBe(true);
    expect(isEditableStatus('PUBLISHED')).toBe(true);
    expect(isEditableStatus('CANCELLED')).toBe(false);
    expect(isEditableStatus('COMPLETED')).toBe(false);
  });
});

describe('request schemas', () => {
  it('password policy', () => {
    expect(passwordSchema.safeParse('Str0ng!Pass').success).toBe(true);
    for (const weak of ['short1!', 'alllowercase1!', 'ALLUPPER1!', 'NoDigits!!', 'NoSymbol123']) {
      expect(passwordSchema.safeParse(weak).success).toBe(false);
    }
    expect(passwordSchema.safeParse(`Aa1!${'é'.repeat(40)}`).success).toBe(false); // > 72 bytes
  });

  it('register normalises email and defaults to CUSTOMER', () => {
    const parsed = registerSchema.parse({
      name: '  Ann  ',
      email: ' Ann@Example.COM ',
      password: 'Str0ng!Pass',
    });
    expect(parsed).toEqual({
      name: 'Ann',
      email: 'ann@example.com',
      password: 'Str0ng!Pass',
      role: 'CUSTOMER',
    });
    expect(registerSchema.safeParse({ ...parsed, role: 'ADMIN' }).success).toBe(false);
  });

  it('public query: date-only "to" is inclusive of that day; defaults applied', () => {
    const parsed = publicEventQuerySchema.parse({ from: '2026-12-01', to: '2026-12-31', q: '  ' });
    expect(parsed.from!.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(parsed.to!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(parsed).toMatchObject({
      q: undefined,
      sort: 'date',
      order: 'asc',
      page: 1,
      pageSize: 12,
    });
  });

  it('event payload requires https banner URLs and integer prices', () => {
    const base = {
      venueId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      title: 'Show',
      startAt: '2027-01-01T18:00:00Z',
      pricing: { strategy: 'BASE' },
      seatMap: {
        rows: 1,
        seatsPerRow: 1,
        categories: [{ name: 'G', priceMinor: 10, rows: ['A'] }],
      },
    };
    expect(createEventSchema.safeParse(base).success).toBe(true);
    expect(createEventSchema.safeParse({ ...base, bannerUrl: 'http://x.com/a.png' }).success).toBe(
      false,
    );
    expect(createEventSchema.safeParse({ ...base, bannerUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(createEventSchema.safeParse({ ...base, startAt: '2027-01-01' }).success).toBe(false);
  });

  it('venue timezone must be a real IANA zone', () => {
    expect(
      venueSchema.safeParse({
        name: 'Hall',
        address: 'Road 1',
        city: 'Dhaka',
        timezone: 'Asia/Dhaka',
      }).success,
    ).toBe(true);
    expect(
      venueSchema.safeParse({
        name: 'Hall',
        address: 'Road 1',
        city: 'Dhaka',
        timezone: 'Nowhere/Land',
      }).success,
    ).toBe(false);
  });
});
