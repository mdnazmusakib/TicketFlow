import { z } from 'zod';
import { EVENT_STATUSES } from '../domain/events/eventRules';
import { MAX_CATEGORIES, MAX_SEAT_ROWS, MAX_SEATS_PER_ROW } from '../domain/events/seatMap';

export const idParamsSchema = z.object({ id: z.uuid() });
export const categoryParamsSchema = z.object({ id: z.uuid(), categoryId: z.uuid() });

const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const nullableIsoDateTime = isoDateTime.nullable();

const httpsUrl = z.url({ protocol: /^https$/, message: 'Must be an https URL' }).max(2000);

const priceMinor = z
  .number()
  .int('Price must be in minor units (integer)')
  .min(0)
  .max(10_000_000_000);

export const pricingSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('BASE') }).strict(),
  z
    .object({
      strategy: z.literal('EARLY_BIRD'),
      earlyBirdDeadline: isoDateTime,
      discountPct: z.number().int().min(1).max(99),
    })
    .strict(),
]);

export const seatMapSchema = z
  .object({
    rows: z.number().int().min(1).max(MAX_SEAT_ROWS),
    seatsPerRow: z.number().int().min(1).max(MAX_SEATS_PER_ROW),
    categories: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            priceMinor,
            rows: z.array(z.string().regex(/^[A-Z]{1,2}$/, 'Row labels are A-Z or AA-AZ')).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CATEGORIES),
  })
  .strict();

const eventDetailsShape = {
  venueId: z.uuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  startAt: isoDateTime,
  endAt: nullableIsoDateTime.optional(),
  pricing: pricingSchema,
  salesStartAt: nullableIsoDateTime.optional(),
  salesEndAt: nullableIsoDateTime.optional(),
  bannerUrl: httpsUrl.nullable().optional(),
};

export const createEventSchema = z
  .object({ ...eventDetailsShape, seatMap: seatMapSchema })
  .strict();

export const updateEventSchema = z
  .object(eventDetailsShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export const updateCategorySchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), priceMinor: priceMinor.optional() })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.priceMinor !== undefined,
    'Nothing to update',
  );

export const assignSeatsSchema = z
  .object({ seatIds: z.array(z.uuid()).min(1).max(1000), categoryId: z.uuid() })
  .strict();

export const organizerEventListSchema = z.object({
  status: z.enum(EVENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const INVALID_DATE_MESSAGE =
  'Invalid date: use a real calendar date as YYYY-MM-DD or an ISO 8601 date-time with a time zone';

/** True only for dates that exist on the calendar (rejects 2026-13-40, 2026-02-30, ...). */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Strict parser for search date filters. No permissive Date.parse fallback, which would
 * accept odd formats or silently roll impossible dates over (Feb 30 becomes Mar 2).
 * - YYYY-MM-DD: that UTC day (with endOfDay, the instant the next day starts)
 * - YYYY-MM-DDTHH:mm[:ss[.SSS]](Z|+HH:mm|-HH:mm): that exact instant
 */
export function parseDateBoundary(value: string, endOfDay: boolean): Date | null {
  const day = DATE_ONLY.exec(value);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (!isCalendarDate(year, month, date)) return null;
    return new Date(Date.UTC(year, month - 1, date + (endOfDay ? 1 : 0)));
  }
  const dt = DATE_TIME.exec(value);
  if (!dt) return null;
  const [year, month, date, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(dt[i]));
  const second = dt[6] ? Number(dt[6]) : 0;
  if (!isCalendarDate(year!, month!, date!) || hour! > 23 || minute! > 59 || second > 59) {
    return null;
  }
  if (dt[9] && (Number(dt[10]) > 14 || Number(dt[11]) > 59)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const dateBoundary = (endOfDay: boolean) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((value, ctx) => {
      const parsed = parseDateBoundary(value, endOfDay);
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: INVALID_DATE_MESSAGE });
        return z.NEVER;
      }
      return parsed;
    });

export const publicEventQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    city: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    from: dateBoundary(false).optional(),
    to: dateBoundary(true).optional(),
    sort: z.enum(['date', 'price', 'title', 'newest']).default('date'),
    order: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(12),
  })
  // 'to' is an exclusive bound (a YYYY-MM-DD 'to' already points at the next midnight, so the
  // whole day is included): the range must not be empty or reversed.
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: '"from" must not be after "to"',
    path: ['to'],
  });

export const venueSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    address: z.string().trim().min(3).max(300),
    city: z.string().trim().min(2).max(100),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((v) => v.toUpperCase())
      .default('BD'),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown IANA timezone')
      .default('Asia/Dhaka'),
  })
  .strict();

export const updateVenueSchema = venueSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
