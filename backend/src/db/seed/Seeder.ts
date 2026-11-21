import bcrypt from 'bcrypt';
import type { Logger } from 'pino';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import {
  DEMO_EVENTS,
  DEMO_USERS,
  DEMO_VENUES,
  rowLabel,
  type SeedEvent,
  type SeedUser,
  type SeedVenue,
} from './seedData';

export interface SeedSummary {
  users: number;
  venues: number;
  events: number;
  seatCategories: number;
  seats: number;
}

export interface SeederOptions {
  bcryptRounds: number;
  logger?: Logger;
  now?: () => Date;
  users?: readonly SeedUser[];
  venues?: readonly SeedVenue[];
  events?: readonly SeedEvent[];
}

const minutesFrom = (base: Date, minutes: number): Date =>
  new Date(base.getTime() + minutes * 60_000);

/**
 * Idempotent demo seed. Everything runs in ONE transaction and uses natural or
 * fixed keys with ON CONFLICT, so re-running converges to the same data set
 * (event dates are re-anchored to "now" so demo events stay in the future).
 */
export class Seeder {
  private readonly users: readonly SeedUser[];
  private readonly venues: readonly SeedVenue[];
  private readonly events: readonly SeedEvent[];

  constructor(
    private readonly db: TransactionRunner,
    private readonly options: SeederOptions,
  ) {
    this.users = options.users ?? DEMO_USERS;
    this.venues = options.venues ?? DEMO_VENUES;
    this.events = options.events ?? DEMO_EVENTS;
  }

  async run(): Promise<SeedSummary> {
    // Hash outside the transaction: bcrypt is CPU-bound and slow by design.
    const hashes = new Map<string, string>();
    for (const user of this.users) {
      hashes.set(user.key, await bcrypt.hash(user.password, this.options.bcryptRounds));
    }
    const now = this.options.now?.() ?? new Date();

    return this.db.withTransaction(async (tx) => {
      const userIds = await this.seedUsers(tx, hashes);
      const venueIds = await this.seedVenues(tx, userIds);
      let seatCategories = 0;
      let seats = 0;
      for (const event of this.events) {
        const result = await this.seedEvent(tx, event, userIds, venueIds, now);
        seatCategories += result.categories;
        seats += result.seats;
      }
      const summary: SeedSummary = {
        users: userIds.size,
        venues: venueIds.size,
        events: this.events.length,
        seatCategories,
        seats,
      };
      this.options.logger?.info(summary, 'Seed complete');
      return summary;
    });
  }

  private async seedUsers(
    tx: Queryable,
    hashes: Map<string, string>,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const user of this.users) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.users (name, email, password_hash, role, email_verified, email_verified_at)
         VALUES ($1, lower($2), $3, $4, true, now())
         ON CONFLICT ((lower(email))) DO UPDATE
           SET name = EXCLUDED.name,
               password_hash = EXCLUDED.password_hash,
               role = EXCLUDED.role,
               email_verified = true,
               email_verified_at = COALESCE(public.users.email_verified_at, now()),
               is_active = true
         RETURNING id`,
        [user.name, user.email, hashes.get(user.key), user.role],
      );
      ids.set(user.key, rows[0]!.id);
    }
    return ids;
  }

  private async seedVenues(
    tx: Queryable,
    userIds: Map<string, string>,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const venue of this.venues) {
      const ownerId = required(userIds, venue.ownerKey, 'user');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.venues (organizer_id, name, address, city)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organizer_id, lower(name), lower(city)) DO UPDATE
           SET address = EXCLUDED.address
         RETURNING id`,
        [ownerId, venue.name, venue.address, venue.city],
      );
      ids.set(venue.key, rows[0]!.id);
    }
    return ids;
  }

  private async seedEvent(
    tx: Queryable,
    event: SeedEvent,
    userIds: Map<string, string>,
    venueIds: Map<string, string>,
    now: Date,
  ): Promise<{ categories: number; seats: number }> {
    const organizerId = required(userIds, event.organizerKey, 'user');
    const venueId = required(venueIds, event.venueKey, 'venue');
    const startAt = minutesFrom(now, event.startOffsetMinutes);
    const endAt = minutesFrom(startAt, event.durationMinutes);
    const earlyBird =
      event.pricing.strategy === 'EARLY_BIRD'
        ? {
            deadline: minutesFrom(now, event.pricing.deadlineOffsetMinutes),
            pct: event.pricing.discountPct,
          }
        : { deadline: null, pct: null };

    await tx.query(
      `INSERT INTO public.events (
         id, organizer_id, venue_id, title, description, start_at, end_at, status,
         pricing_strategy, early_bird_deadline, early_bird_discount_pct,
         seat_rows, seats_per_row, published_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::varchar, $9, $10, $11, $12, $13,
               CASE WHEN $8::varchar = 'PUBLISHED' THEN now() END)
       ON CONFLICT (id) DO UPDATE SET
         venue_id = EXCLUDED.venue_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         status = EXCLUDED.status,
         pricing_strategy = EXCLUDED.pricing_strategy,
         early_bird_deadline = EXCLUDED.early_bird_deadline,
         early_bird_discount_pct = EXCLUDED.early_bird_discount_pct,
         seat_rows = EXCLUDED.seat_rows,
         seats_per_row = EXCLUDED.seats_per_row,
         published_at = CASE WHEN EXCLUDED.status = 'PUBLISHED'
                             THEN COALESCE(public.events.published_at, now()) END`,
      [
        event.id,
        organizerId,
        venueId,
        event.title,
        event.description,
        startAt,
        endAt,
        event.status,
        event.pricing.strategy,
        earlyBird.deadline,
        earlyBird.pct,
        event.seatRows,
        event.seatsPerRow,
      ],
    );

    const labels = Array.from({ length: event.seatRows }, (_, index) => rowLabel(index));
    const categoryByRow = new Map<string, string>();

    for (const [sortOrder, category] of event.categories.entries()) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.seat_categories (event_id, name, price_minor, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id, lower(name)) DO UPDATE
           SET price_minor = EXCLUDED.price_minor, sort_order = EXCLUDED.sort_order
         RETURNING id`,
        [event.id, category.name, category.priceMinor, sortOrder],
      );
      for (const row of category.rows) categoryByRow.set(row, rows[0]!.id);
    }

    const rowLabels: string[] = [];
    const seatNumbers: number[] = [];
    const categoryIds: string[] = [];
    for (const label of labels) {
      const categoryId = categoryByRow.get(label);
      if (!categoryId)
        throw new Error(`Seed event "${event.title}" has no category for row ${label}`);
      for (let seat = 1; seat <= event.seatsPerRow; seat += 1) {
        rowLabels.push(label);
        seatNumbers.push(seat);
        categoryIds.push(categoryId);
      }
    }

    // Bulk upsert of the full rows x seats map in one statement.
    await tx.query(
      `INSERT INTO public.seats (event_id, row_label, seat_number, category_id)
       SELECT $1, r, n, c FROM unnest($2::varchar[], $3::smallint[], $4::uuid[]) AS t(r, n, c)
       ON CONFLICT (event_id, row_label, seat_number) DO UPDATE SET category_id = EXCLUDED.category_id`,
      [event.id, rowLabels, seatNumbers, categoryIds],
    );

    // Remove seats outside the current map, but never seats with booking history.
    await tx.query(
      `DELETE FROM public.seats s
       WHERE s.event_id = $1
         AND (s.row_label <> ALL($2::varchar[]) OR s.seat_number > $3)
         AND NOT EXISTS (SELECT 1 FROM public.booking_seats bs WHERE bs.seat_id = s.id)`,
      [event.id, labels, event.seatsPerRow],
    );

    return { categories: event.categories.length, seats: rowLabels.length };
  }
}

function required(map: Map<string, string>, key: string, kind: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Seed data references unknown ${kind} "${key}"`);
  return value;
}
