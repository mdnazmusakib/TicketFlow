import type { EventStatus, PricingStrategyName } from '../domain/events/eventRules';
import type { Queryable } from '../infrastructure/database/types';

export interface EventVenueSummary {
  id: string;
  name: string;
  address: string;
  city: string;
  countryCode: string;
  timezone: string;
}

export interface EventRecord {
  id: string;
  organizerId: string;
  venueId: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date | null;
  status: EventStatus;
  pricingStrategy: PricingStrategyName;
  earlyBirdDeadline: Date | null;
  earlyBirdDiscountPct: number | null;
  currency: string;
  seatRows: number;
  seatsPerRow: number;
  bannerUrl: string | null;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  venue: EventVenueSummary;
}

export interface EventStats {
  totalSeats: number;
  availableSeats: number;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
}

export type EventWithStats = EventRecord & EventStats;

export interface EventWriteInput {
  venueId: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date | null;
  pricingStrategy: PricingStrategyName;
  earlyBirdDeadline: Date | null;
  earlyBirdDiscountPct: number | null;
  currency: string;
  seatRows: number;
  seatsPerRow: number;
  bannerUrl: string | null;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
}

export type PublicSort = 'date' | 'price' | 'title' | 'newest';

export interface PublicEventQuery {
  q?: string;
  city?: string;
  from?: Date;
  to?: Date;
  sort: PublicSort;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

interface EventRow {
  id: string;
  organizer_id: string;
  venue_id: string;
  title: string;
  description: string | null;
  start_at: Date;
  end_at: Date | null;
  status: EventStatus;
  pricing_strategy: PricingStrategyName;
  early_bird_deadline: Date | null;
  early_bird_discount_pct: number | null;
  currency: string;
  seat_rows: number;
  seats_per_row: number;
  banner_url: string | null;
  sales_start_at: Date | null;
  sales_end_at: Date | null;
  published_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  v_name: string;
  v_address: string;
  v_city: string;
  v_country_code: string;
  v_timezone: string;
}

interface StatsRow {
  total_seats: number;
  available_seats: number;
  min_price_minor: string | null;
  max_price_minor: string | null;
  total_count?: number;
}

/** A seat allocation blocks the seat while BOOKED, or HELD with an unexpired hold. */
export const ACTIVE_ALLOCATION_SQL = `(bs.seat_state = 'BOOKED' OR (bs.seat_state = 'HELD'
  AND b.status IN ('HELD', 'PENDING_PAYMENT') AND b.hold_expires_at > now()))`;

/** Bookings that still occupy inventory or represent a sale. */
export const ACTIVE_BOOKING_SQL = `(b.status = 'CONFIRMED' OR (b.status IN ('HELD', 'PENDING_PAYMENT')
  AND b.hold_expires_at > now()))`;

const SELECT_EVENT = `
  SELECT e.*, v.name AS v_name, v.address AS v_address, v.city AS v_city,
         v.country_code AS v_country_code, v.timezone AS v_timezone
  FROM events e JOIN venues v ON v.id = e.venue_id`;

const STATS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total_seats,
           (count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
              WHERE bs.seat_id = s.id AND ${ACTIVE_ALLOCATION_SQL})))::int AS available_seats
    FROM seats s WHERE s.event_id = e.id
  ) st ON true
  LEFT JOIN LATERAL (
    SELECT min(price_minor) AS min_price_minor, max(price_minor) AS max_price_minor
    FROM seat_categories c WHERE c.event_id = e.id
  ) pr ON true`;

const SORT_SQL: Record<PublicSort, string> = {
  date: 'e.start_at',
  price: 'pr.min_price_minor',
  title: 'lower(e.title)',
  newest: 'e.created_at',
};

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    organizerId: row.organizer_id,
    venueId: row.venue_id,
    title: row.title,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    pricingStrategy: row.pricing_strategy,
    earlyBirdDeadline: row.early_bird_deadline,
    earlyBirdDiscountPct: row.early_bird_discount_pct,
    currency: row.currency,
    seatRows: row.seat_rows,
    seatsPerRow: row.seats_per_row,
    bannerUrl: row.banner_url,
    salesStartAt: row.sales_start_at,
    salesEndAt: row.sales_end_at,
    publishedAt: row.published_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    venue: {
      id: row.venue_id,
      name: row.v_name,
      address: row.v_address,
      city: row.v_city,
      countryCode: row.v_country_code,
      timezone: row.v_timezone,
    },
  };
}

function toStats(row: StatsRow): EventStats {
  return {
    totalSeats: row.total_seats ?? 0,
    availableSeats: row.available_seats ?? 0,
    minPriceMinor: row.min_price_minor === null ? null : Number(row.min_price_minor),
    maxPriceMinor: row.max_price_minor === null ? null : Number(row.max_price_minor),
  };
}

/** Escapes LIKE wildcards so user input is matched literally. */
function likeContains(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class EventRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    organizerId: string,
    input: EventWriteInput,
    db: Queryable = this.db,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO events (organizer_id, venue_id, title, description, start_at, end_at,
         pricing_strategy, early_bird_deadline, early_bird_discount_pct, currency,
         seat_rows, seats_per_row, banner_url, sales_start_at, sales_end_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        organizerId,
        input.venueId,
        input.title,
        input.description,
        input.startAt,
        input.endAt,
        input.pricingStrategy,
        input.earlyBirdDeadline,
        input.earlyBirdDiscountPct,
        input.currency,
        input.seatRows,
        input.seatsPerRow,
        input.bannerUrl,
        input.salesStartAt,
        input.salesEndAt,
      ],
    );
    return rows[0]!.id;
  }

  async findById(
    id: string,
    db: Queryable = this.db,
    forUpdate = false,
  ): Promise<EventRecord | null> {
    const { rows } = await db.query<EventRow>(
      `${SELECT_EVENT} WHERE e.id = $1${forUpdate ? ' FOR UPDATE OF e' : ''}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findWithStats(id: string): Promise<EventWithStats | null> {
    const { rows } = await this.db.query<EventRow & StatsRow>(
      `SELECT e.*, v.name AS v_name, v.address AS v_address, v.city AS v_city,
              v.country_code AS v_country_code, v.timezone AS v_timezone, st.*, pr.*
       FROM events e JOIN venues v ON v.id = e.venue_id ${STATS_LATERAL}
       WHERE e.id = $1`,
      [id],
    );
    return rows[0] ? { ...toRecord(rows[0]), ...toStats(rows[0]) } : null;
  }

  /** organizerId = null lists all events (ADMIN). */
  async listForOrganizer(
    organizerId: string | null,
    filter: { status?: EventStatus; page: number; pageSize: number },
  ): Promise<{ items: EventWithStats[]; total: number }> {
    const { rows } = await this.db.query<EventRow & StatsRow>(
      `SELECT e.*, v.name AS v_name, v.address AS v_address, v.city AS v_city,
              v.country_code AS v_country_code, v.timezone AS v_timezone, st.*, pr.*,
              count(*) OVER()::int AS total_count
       FROM events e JOIN venues v ON v.id = e.venue_id ${STATS_LATERAL}
       WHERE ($1::uuid IS NULL OR e.organizer_id = $1)
         AND ($2::varchar IS NULL OR e.status = $2)
       ORDER BY e.start_at DESC, e.id
       LIMIT $3 OFFSET $4`,
      [organizerId, filter.status ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return {
      items: rows.map((row) => ({ ...toRecord(row), ...toStats(row) })),
      total: rows[0]?.total_count ?? 0,
    };
  }

  async searchPublic(query: PublicEventQuery): Promise<{ items: EventWithStats[]; total: number }> {
    const direction = query.order === 'desc' ? 'DESC' : 'ASC';
    const { rows } = await this.db.query<EventRow & StatsRow>(
      `SELECT e.*, v.name AS v_name, v.address AS v_address, v.city AS v_city,
              v.country_code AS v_country_code, v.timezone AS v_timezone, st.*, pr.*,
              count(*) OVER()::int AS total_count
       FROM events e JOIN venues v ON v.id = e.venue_id ${STATS_LATERAL}
       WHERE e.status = 'PUBLISHED' AND e.start_at > now()
         AND ($1::text IS NULL OR lower(e.title) LIKE $1 OR lower(v.name) LIKE $1)
         AND ($2::text IS NULL OR lower(v.city) = lower($2))
         AND ($3::timestamptz IS NULL OR e.start_at >= $3)
         AND ($4::timestamptz IS NULL OR e.start_at < $4)
       ORDER BY ${SORT_SQL[query.sort]} ${direction} NULLS LAST, e.start_at ASC, e.id
       LIMIT $5 OFFSET $6`,
      [
        query.q ? likeContains(query.q) : null,
        query.city ?? null,
        query.from ?? null,
        query.to ?? null,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ],
    );
    return {
      items: rows.map((row) => ({ ...toRecord(row), ...toStats(row) })),
      total: rows[0]?.total_count ?? 0,
    };
  }

  async listPublicCities(): Promise<string[]> {
    const { rows } = await this.db.query<{ city: string }>(
      `SELECT DISTINCT ON (lower(v.city)) v.city FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.status = 'PUBLISHED' AND e.start_at > now() ORDER BY lower(v.city)`,
    );
    return rows.map((row) => row.city);
  }

  async update(id: string, input: EventWriteInput, db: Queryable = this.db): Promise<void> {
    await db.query(
      `UPDATE events SET venue_id = $2, title = $3, description = $4, start_at = $5, end_at = $6,
         pricing_strategy = $7, early_bird_deadline = $8, early_bird_discount_pct = $9,
         banner_url = $10, sales_start_at = $11, sales_end_at = $12
       WHERE id = $1`,
      [
        id,
        input.venueId,
        input.title,
        input.description,
        input.startAt,
        input.endAt,
        input.pricingStrategy,
        input.earlyBirdDeadline,
        input.earlyBirdDiscountPct,
        input.bannerUrl,
        input.salesStartAt,
        input.salesEndAt,
      ],
    );
  }

  async updateSeatMapSize(
    id: string,
    rows: number,
    seatsPerRow: number,
    db: Queryable,
  ): Promise<void> {
    await db.query('UPDATE events SET seat_rows = $2, seats_per_row = $3 WHERE id = $1', [
      id,
      rows,
      seatsPerRow,
    ]);
  }

  async setStatus(id: string, status: EventStatus, db: Queryable = this.db): Promise<void> {
    await db.query(
      `UPDATE events SET status = $2::varchar,
         published_at = CASE WHEN $2::varchar = 'PUBLISHED' THEN COALESCE(published_at, now())
                             WHEN $2::varchar = 'DRAFT' THEN NULL ELSE published_at END,
         cancelled_at = CASE WHEN $2::varchar = 'CANCELLED' THEN now() ELSE NULL END
       WHERE id = $1`,
      [id, status],
    );
  }

  async countActiveBookings(eventId: string, db: Queryable = this.db): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings b WHERE b.event_id = $1 AND ${ACTIVE_BOOKING_SQL}`,
      [eventId],
    );
    return rows[0]?.n ?? 0;
  }

  /** True if any booking (in any state) ever referenced the event. */
  async hasBookingHistory(eventId: string, db: Queryable = this.db): Promise<boolean> {
    const { rows } = await db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM bookings WHERE event_id = $1) AS exists',
      [eventId],
    );
    return rows[0]?.exists ?? false;
  }

  async delete(id: string, db: Queryable = this.db): Promise<void> {
    await db.query('DELETE FROM events WHERE id = $1', [id]);
  }
}
