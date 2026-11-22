import type { Queryable } from '../infrastructure/database/types';
import { ACTIVE_ALLOCATION_SQL } from './EventRepository';

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

export interface EventSalesStats {
  eventId: string;
  title: string;
  status: string;
  startAt: Date;
  pricingStrategy: string;
  earlyBirdDeadline: Date | null;
  earlyBirdDiscountPct: number | null;
  currency: string;
  totalSeats: number;
  soldSeats: number;
  heldSeats: number;
  grossRevenueMinor: number;
  refundedMinor: number;
}

/** Read-only aggregates for dashboards (all money in minor units). */
export class DashboardRepository {
  constructor(private readonly db: Queryable) {}

  // ------------------------------------------------------------ customer

  async customerStats(customerId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM bookings WHERE customer_id = $1) AS total_bookings,
         (SELECT count(*) FROM bookings b JOIN events e ON e.id = b.event_id
            WHERE b.customer_id = $1 AND b.status = 'CONFIRMED' AND e.start_at > now()) AS upcoming_bookings,
         (SELECT coalesce(sum(p.amount_minor), 0) FROM payments p JOIN bookings b ON b.id = p.booking_id
            WHERE b.customer_id = $1 AND p.status = 'SUCCEEDED') AS paid_minor,
         (SELECT coalesce(sum(r.amount_minor), 0) FROM refunds r JOIN bookings b ON b.id = r.booking_id
            WHERE b.customer_id = $1 AND r.status = 'SUCCEEDED') AS refunded_minor,
         (SELECT count(*) FROM refunds r JOIN bookings b ON b.id = r.booking_id
            WHERE b.customer_id = $1 AND r.status IN ('PENDING', 'PROCESSING')) AS refunds_in_progress`,
      [customerId],
    );
    const row = rows[0] ?? {};
    return {
      totalBookings: num(row.total_bookings),
      upcomingBookings: num(row.upcoming_bookings),
      paidMinor: num(row.paid_minor),
      refundedMinor: num(row.refunded_minor),
      refundsInProgress: num(row.refunds_in_progress),
    };
  }

  async upcomingForCustomer(customerId: string, limit: number) {
    const { rows } = await this.db.query<{
      id: string;
      title: string;
      start_at: Date;
      venue_name: string;
      venue_city: string;
      timezone: string;
      seat_count: number;
      total_amount_minor: string;
      currency: string;
    }>(
      `SELECT b.id, e.title, e.start_at, v.name AS venue_name, v.city AS venue_city, v.timezone,
              (SELECT count(*)::int FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count,
              b.total_amount_minor, b.currency
       FROM bookings b JOIN events e ON e.id = b.event_id JOIN venues v ON v.id = e.venue_id
       WHERE b.customer_id = $1 AND b.status = 'CONFIRMED' AND e.start_at > now()
       ORDER BY e.start_at LIMIT $2`,
      [customerId, limit],
    );
    return rows.map((row) => ({
      bookingId: row.id,
      eventTitle: row.title,
      startAt: row.start_at.toISOString(),
      venue: `${row.venue_name}, ${row.venue_city}`,
      timezone: row.timezone,
      seatCount: row.seat_count,
      totalAmountMinor: Number(row.total_amount_minor),
      currency: row.currency,
    }));
  }

  // ----------------------------------------------------------- organizer

  /** organizerId = null aggregates every organizer (ADMIN). */
  async eventSales(
    organizerId: string | null,
    options: { eventId?: string; upcomingOnly?: boolean; limit?: number },
  ): Promise<EventSalesStats[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT e.id, e.title, e.status, e.start_at, e.pricing_strategy, e.early_bird_deadline,
              e.early_bird_discount_pct, e.currency,
              (SELECT count(*) FROM seats s WHERE s.event_id = e.id) AS total_seats,
              (SELECT count(*) FROM booking_seats bs WHERE bs.event_id = e.id AND bs.seat_state = 'BOOKED') AS sold_seats,
              (SELECT count(*) FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
                 WHERE bs.event_id = e.id AND bs.seat_state = 'HELD' AND ${ACTIVE_ALLOCATION_SQL}) AS held_seats,
              (SELECT coalesce(sum(p.amount_minor), 0) FROM payments p JOIN bookings b ON b.id = p.booking_id
                 WHERE b.event_id = e.id AND p.status = 'SUCCEEDED') AS gross_minor,
              (SELECT coalesce(sum(r.amount_minor), 0) FROM refunds r JOIN bookings b ON b.id = r.booking_id
                 WHERE b.event_id = e.id AND r.status = 'SUCCEEDED') AS refunded_minor
       FROM events e
       WHERE ($1::uuid IS NULL OR e.organizer_id = $1)
         AND ($2::uuid IS NULL OR e.id = $2)
         AND ($3::boolean = false OR (e.start_at > now() AND e.status IN ('DRAFT', 'PUBLISHED')))
       ORDER BY e.start_at
       LIMIT $4`,
      [organizerId, options.eventId ?? null, options.upcomingOnly ?? false, options.limit ?? 1000],
    );
    return rows.map((row) => ({
      eventId: String(row.id),
      title: String(row.title),
      status: String(row.status),
      startAt: row.start_at as Date,
      pricingStrategy: String(row.pricing_strategy),
      earlyBirdDeadline: (row.early_bird_deadline as Date | null) ?? null,
      earlyBirdDiscountPct:
        row.early_bird_discount_pct === null ? null : num(row.early_bird_discount_pct),
      currency: String(row.currency),
      totalSeats: num(row.total_seats),
      soldSeats: num(row.sold_seats),
      heldSeats: num(row.held_seats),
      grossRevenueMinor: num(row.gross_minor),
      refundedMinor: num(row.refunded_minor),
    }));
  }

  async eventStatusCounts(organizerId: string | null): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM events WHERE ($1::uuid IS NULL OR organizer_id = $1) GROUP BY status`,
      [organizerId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async bookingStatusCounts(
    organizerId: string | null,
    eventId?: string,
  ): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; n: number }>(
      `SELECT b.status, count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id
       WHERE ($1::uuid IS NULL OR e.organizer_id = $1) AND ($2::uuid IS NULL OR b.event_id = $2)
       GROUP BY b.status`,
      [organizerId, eventId ?? null],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async categorySales(eventId: string) {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      price_minor: string;
      total: number;
      sold: number;
      held: number;
    }>(
      `SELECT c.id, c.name, c.price_minor,
              count(s.id)::int AS total,
              count(s.id) FILTER (WHERE EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.seat_id = s.id AND bs.seat_state = 'BOOKED'))::int AS sold,
              count(s.id) FILTER (WHERE EXISTS (SELECT 1 FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
                 WHERE bs.seat_id = s.id AND bs.seat_state = 'HELD' AND ${ACTIVE_ALLOCATION_SQL}))::int AS held
       FROM seat_categories c LEFT JOIN seats s ON s.category_id = c.id
       WHERE c.event_id = $1 GROUP BY c.id ORDER BY c.sort_order, lower(c.name)`,
      [eventId],
    );
    return rows.map((row) => ({
      categoryId: row.id,
      name: row.name,
      priceMinor: Number(row.price_minor),
      totalSeats: row.total,
      soldSeats: row.sold,
      heldSeats: row.held,
    }));
  }

  /** Bookings of one event for its organizer: attendee name and a masked email only. */
  async eventBookings(
    eventId: string,
    filter: { status?: string; page: number; pageSize: number },
  ) {
    const { rows } = await this.db.query<{
      id: string;
      status: string;
      customer_name: string;
      customer_email: string;
      seat_count: number;
      total_amount_minor: string;
      refund_amount_minor: string;
      currency: string;
      created_at: Date;
      confirmed_at: Date | null;
      payment_provider: string | null;
      total_count: number;
    }>(
      `SELECT b.id, b.status, u.name AS customer_name, u.email AS customer_email,
              (SELECT count(*)::int FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count,
              b.total_amount_minor, b.refund_amount_minor, b.currency, b.created_at, b.confirmed_at,
              (SELECT p.provider FROM payments p WHERE p.booking_id = b.id AND p.status = 'SUCCEEDED' LIMIT 1) AS payment_provider,
              count(*) OVER()::int AS total_count
       FROM bookings b JOIN users u ON u.id = b.customer_id
       WHERE b.event_id = $1 AND ($2::varchar IS NULL OR b.status = $2)
       ORDER BY b.created_at DESC, b.id
       LIMIT $3 OFFSET $4`,
      [eventId, filter.status ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return {
      items: rows.map((row) => ({
        bookingId: row.id,
        status: row.status,
        customerName: row.customer_name,
        customerEmail: maskEmail(row.customer_email),
        seatCount: row.seat_count,
        totalAmountMinor: Number(row.total_amount_minor),
        refundAmountMinor: Number(row.refund_amount_minor),
        currency: row.currency,
        paymentProvider: row.payment_provider,
        createdAt: row.created_at.toISOString(),
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
      })),
      total: rows[0]?.total_count ?? 0,
    };
  }

  // --------------------------------------------------------------- admin

  async platformCounts() {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM users WHERE role = 'CUSTOMER') AS customers,
         (SELECT count(*) FROM users WHERE role = 'ORGANIZER') AS organizers,
         (SELECT count(*) FROM users WHERE role = 'ADMIN') AS admins,
         (SELECT count(*) FROM events) AS events,
         (SELECT count(*) FROM bookings) AS bookings,
         (SELECT coalesce(sum(amount_minor), 0) FROM payments WHERE status = 'SUCCEEDED') AS paid_minor,
         (SELECT coalesce(sum(amount_minor), 0) FROM refunds WHERE status = 'SUCCEEDED') AS refunded_minor,
         (SELECT count(*) FROM refunds r WHERE r.status = 'FAILED'
            AND r.attempt = (SELECT max(attempt) FROM refunds x WHERE x.payment_id = r.payment_id)) AS failed_refunds,
         (SELECT count(*) FROM payments WHERE status IN ('INITIATED', 'PENDING')) AS open_payments`,
    );
    const row = rows[0] ?? {};
    return {
      users: {
        customers: num(row.customers),
        organizers: num(row.organizers),
        admins: num(row.admins),
      },
      events: num(row.events),
      bookings: num(row.bookings),
      paidMinor: num(row.paid_minor),
      refundedMinor: num(row.refunded_minor),
      failedRefunds: num(row.failed_refunds),
      openPayments: num(row.open_payments),
    };
  }

  async listUsers(filter: { q?: string; role?: string; page: number; pageSize: number }) {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      email: string;
      role: string;
      email_verified: boolean;
      is_active: boolean;
      created_at: Date;
      last_login_at: Date | null;
      total_count: number;
    }>(
      `SELECT id, name, email, role, email_verified, is_active, created_at, last_login_at,
              count(*) OVER()::int AS total_count
       FROM users
       WHERE ($1::text IS NULL OR lower(name) LIKE $1 OR lower(email) LIKE $1)
         AND ($2::varchar IS NULL OR role = $2)
       ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
      [
        filter.q ? `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
        filter.role ?? null,
        filter.pageSize,
        (filter.page - 1) * filter.pageSize,
      ],
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        emailVerified: row.email_verified,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        lastLoginAt: row.last_login_at?.toISOString() ?? null,
      })),
      total: rows[0]?.total_count ?? 0,
    };
  }
}

/** "rahim@example.com" -> "r***m@example.com" (organizers see who booked, not full contact data). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}
