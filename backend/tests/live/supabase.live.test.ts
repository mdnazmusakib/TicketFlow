import { Database } from '../../src/infrastructure/database/Database';
import { createPool } from '../../src/infrastructure/database/pool';
import { loadMigrationFiles } from '../../src/db/Migrator';
import { DEMO_USERS } from '../../src/db/seed/seedData';
import { PostgresHealthProbe } from '../../src/repositories/HealthProbes';
import { testConfig } from '../helpers/testApp';

/**
 * Read-only checks against the configured Supabase database (npm run test:live).
 * Any write happens inside a transaction that is always rolled back.
 */
const url = process.env.LIVE_DATABASE_URL;
if (!url) throw new Error('LIVE_DATABASE_URL is required (run via npm run test:live)');

class Rollback extends Error {}

describe('Supabase PostgreSQL (live)', () => {
  let db: Database;

  beforeAll(() => {
    const config = testConfig({
      DATABASE_URL: url!,
      DATABASE_SSL: process.env.DATABASE_SSL ?? 'true',
    });
    db = new Database(createPool(config.database));
  });

  afterAll(async () => {
    await db.close();
  });

  it('is reachable and fully migrated', async () => {
    const files = await loadMigrationFiles();
    await expect(new PostgresHealthProbe(db).check()).resolves.toEqual({
      schemaVersion: files[files.length - 1]!.version,
    });
  });

  it('locks every public table away from the Supabase Data API roles', async () => {
    const { rows } = await db.query<{
      table_name: string;
      rls: boolean;
      anon: boolean;
      authed: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls,
              has_table_privilege('anon', c.oid, 'SELECT') AS anon,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS authed
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.filter((r) => !r.rls)).toEqual([]);
    expect(rows.filter((r) => r.anon || r.authed)).toEqual([]);
  });

  it('contains the seeded demo accounts', async () => {
    const { rows } = await db.query<{ email: string }>(
      'SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1)',
      [DEMO_USERS.map((u) => u.email.toLowerCase())],
    );
    expect(rows).toHaveLength(DEMO_USERS.length);
  });

  it('runs real transactions: the double-booking index rejects a duplicate hold (rolled back)', async () => {
    const outcome = db.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ event_id: string; seat_id: string; customer_id: string }>(
        `SELECT s.event_id, s.id AS seat_id,
                (SELECT id FROM users WHERE role = 'CUSTOMER' ORDER BY created_at LIMIT 1) AS customer_id
         FROM seats s JOIN events e ON e.id = s.event_id WHERE e.status = 'PUBLISHED' LIMIT 1`,
      );
      const { event_id: eventId, seat_id: seatId, customer_id: customerId } = rows[0]!;
      const hold = async () => {
        const booking = await tx.query<{ id: string }>(
          `INSERT INTO bookings (event_id, customer_id, hold_expires_at, pricing_strategy, total_amount_minor, currency)
           VALUES ($1, $2, now() + interval '5 minutes', 'BASE', 1000, 'BDT') RETURNING id`,
          [eventId, customerId],
        );
        await tx.query(
          'INSERT INTO booking_seats (booking_id, event_id, seat_id, price_minor) VALUES ($1, $2, $3, 1000)',
          [booking.rows[0]!.id, eventId, seatId],
        );
      };
      await hold();
      await expect(hold()).rejects.toMatchObject({
        code: '23505',
        constraint: 'idx_active_seat_per_event',
      });
      throw new Rollback();
    });
    await expect(outcome).rejects.toBeInstanceOf(Rollback);
  });
});
