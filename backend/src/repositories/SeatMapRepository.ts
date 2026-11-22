import type { GeneratedSeat, SeatCategoryDefinition } from '../domain/events/seatMap';
import type { Queryable } from '../infrastructure/database/types';
import { ACTIVE_ALLOCATION_SQL } from './EventRepository';

export interface SeatCategoryRecord {
  id: string;
  eventId: string;
  name: string;
  priceMinor: number;
  sortOrder: number;
  totalSeats: number;
  availableSeats: number;
}

export type SeatStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface SeatRecord {
  id: string;
  rowLabel: string;
  seatNumber: number;
  categoryId: string;
  status: SeatStatus;
}

interface CategoryRow {
  id: string;
  event_id: string;
  name: string;
  price_minor: string;
  sort_order: number;
  total_seats: number;
  available_seats: number;
}

interface SeatRow {
  id: string;
  row_label: string;
  seat_number: number;
  category_id: string;
  unavailable: boolean;
}

const UNAVAILABLE_SQL = `EXISTS (SELECT 1 FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
  WHERE bs.seat_id = s.id AND ${ACTIVE_ALLOCATION_SQL})`;

export class SeatMapRepository {
  constructor(private readonly db: Queryable) {}

  async listCategories(eventId: string, db: Queryable = this.db): Promise<SeatCategoryRecord[]> {
    const { rows } = await db.query<CategoryRow>(
      `SELECT c.id, c.event_id, c.name, c.price_minor, c.sort_order,
              count(s.id)::int AS total_seats,
              (count(s.id) FILTER (WHERE s.id IS NOT NULL AND NOT ${UNAVAILABLE_SQL}))::int AS available_seats
       FROM seat_categories c LEFT JOIN seats s ON s.category_id = c.id
       WHERE c.event_id = $1
       GROUP BY c.id ORDER BY c.sort_order, lower(c.name)`,
      [eventId],
    );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      name: row.name,
      priceMinor: Number(row.price_minor),
      sortOrder: row.sort_order,
      totalSeats: row.total_seats,
      availableSeats: row.available_seats,
    }));
  }

  /** Seats with availability only — never who holds or bought them. */
  async listSeats(eventId: string): Promise<SeatRecord[]> {
    const { rows } = await this.db.query<SeatRow>(
      `SELECT s.id, s.row_label, s.seat_number, s.category_id, ${UNAVAILABLE_SQL} AS unavailable
       FROM seats s WHERE s.event_id = $1
       ORDER BY length(s.row_label), s.row_label, s.seat_number`,
      [eventId],
    );
    return rows.map((row) => ({
      id: row.id,
      rowLabel: row.row_label,
      seatNumber: row.seat_number,
      categoryId: row.category_id,
      status: row.unavailable ? 'UNAVAILABLE' : 'AVAILABLE',
    }));
  }

  /**
   * Replaces categories and seats of an event in the caller's transaction.
   * Only allowed (by EventService) when the event has no booking history.
   */
  async replaceSeatMap(
    eventId: string,
    categories: SeatCategoryDefinition[],
    seats: GeneratedSeat[],
    db: Queryable,
  ): Promise<void> {
    await db.query('DELETE FROM seats WHERE event_id = $1', [eventId]);
    await db.query('DELETE FROM seat_categories WHERE event_id = $1', [eventId]);

    const idsByName = new Map<string, string>();
    for (const [sortOrder, category] of categories.entries()) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO seat_categories (event_id, name, price_minor, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
        [eventId, category.name, category.priceMinor, sortOrder],
      );
      idsByName.set(category.name, rows[0]!.id);
    }

    await db.query(
      `INSERT INTO seats (event_id, row_label, seat_number, category_id)
       SELECT $1, r, n, c FROM unnest($2::varchar[], $3::smallint[], $4::uuid[]) AS t(r, n, c)`,
      [
        eventId,
        seats.map((seat) => seat.rowLabel),
        seats.map((seat) => seat.seatNumber),
        seats.map((seat) => idsByName.get(seat.categoryName)),
      ],
    );
  }

  async updateCategory(
    eventId: string,
    categoryId: string,
    patch: { name?: string; priceMinor?: number },
    db: Queryable = this.db,
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE seat_categories SET name = COALESCE($3, name), price_minor = COALESCE($4, price_minor)
       WHERE id = $2 AND event_id = $1`,
      [eventId, categoryId, patch.name ?? null, patch.priceMinor ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async categoryBelongsToEvent(
    eventId: string,
    categoryId: string,
    db: Queryable = this.db,
  ): Promise<boolean> {
    const { rows } = await db.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM seat_categories WHERE id = $2 AND event_id = $1) AS ok',
      [eventId, categoryId],
    );
    return rows[0]?.ok ?? false;
  }

  async countSeatsInEvent(
    eventId: string,
    seatIds: string[],
    db: Queryable = this.db,
  ): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM seats WHERE event_id = $1 AND id = ANY($2::uuid[])',
      [eventId, seatIds],
    );
    return rows[0]?.n ?? 0;
  }

  async countActiveAllocations(seatIds: string[], db: Queryable = this.db): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
       WHERE bs.seat_id = ANY($1::uuid[]) AND ${ACTIVE_ALLOCATION_SQL}`,
      [seatIds],
    );
    return rows[0]?.n ?? 0;
  }

  async assignCategory(
    eventId: string,
    seatIds: string[],
    categoryId: string,
    db: Queryable,
  ): Promise<number> {
    const { rowCount } = await db.query(
      'UPDATE seats SET category_id = $3 WHERE event_id = $1 AND id = ANY($2::uuid[])',
      [eventId, seatIds, categoryId],
    );
    return rowCount ?? 0;
  }
}
