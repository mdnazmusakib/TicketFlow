import bcrypt from 'bcrypt';
import { Seeder } from '../../../src/db/seed/Seeder';
import { DEMO_EVENTS, DEMO_USERS } from '../../../src/db/seed/seedData';
import { PostgresHealthProbe } from '../../../src/repositories/HealthProbes';
import { insertUser } from '../../helpers/fixtures';
import { createTestDatabase, type TestDatabase } from '../../helpers/testDatabase';

describe('Database transactions (real PostgreSQL)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: true });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('commits every statement of a successful transaction', async () => {
    const ids = await testDb.db.withTransaction(async (tx) => [
      await insertUser(tx),
      await insertUser(tx),
    ]);
    const { rows } = await testDb.db.query(
      'SELECT count(*)::int AS n FROM users WHERE id = ANY($1)',
      [ids],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('rolls back every statement when any statement fails', async () => {
    let createdId = '';
    await expect(
      testDb.db.withTransaction(async (tx) => {
        createdId = await insertUser(tx);
        await tx.query(
          `INSERT INTO users (name, email, password_hash, role) VALUES ('x', 'bad', 'x', 'CUSTOMER')`,
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    const { rows } = await testDb.db.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [
      createdId,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  it('retries SERIALIZABLE conflicts so both transactions eventually succeed', async () => {
    await testDb.db.query(
      'CREATE TABLE IF NOT EXISTS counters (id int PRIMARY KEY, value int NOT NULL)',
    );
    await testDb.db.query(
      'INSERT INTO counters VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET value = 0',
    );

    const increment = () =>
      testDb.db.withTransaction(
        async (tx) => {
          const { rows } = await tx.query<{ value: number }>(
            'SELECT value FROM counters WHERE id = 1',
          );
          await tx.query('SELECT pg_sleep(0.05)');
          await tx.query('UPDATE counters SET value = $1 WHERE id = 1', [rows[0]!.value + 1]);
        },
        { isolationLevel: 'SERIALIZABLE', maxRetries: 5 },
      );

    await Promise.all([increment(), increment()]);
    const { rows } = await testDb.db.query<{ value: number }>(
      'SELECT value FROM counters WHERE id = 1',
    );
    expect(rows[0]!.value).toBe(2);
  });

  it('enforces READ ONLY transactions', async () => {
    await expect(
      testDb.db.withTransaction(async (tx) => insertUser(tx), { readOnly: true }),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('health probe reports connectivity and the applied schema version', async () => {
    await expect(new PostgresHealthProbe(testDb.db).check()).resolves.toEqual({
      schemaVersion: '0007',
    });
    await expect(testDb.db.ping()).resolves.toBeUndefined();
  });
});

describe('Seeder (real PostgreSQL)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: true });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  const counts = async () => {
    const { rows } = await testDb.db.query<Record<string, number>>(`
      SELECT (SELECT count(*)::int FROM users) AS users,
             (SELECT count(*)::int FROM venues) AS venues,
             (SELECT count(*)::int FROM events) AS events,
             (SELECT count(*)::int FROM seat_categories) AS categories,
             (SELECT count(*)::int FROM seats) AS seats`);
    return rows[0]!;
  };

  it('seeds demo users, venues, events, categories and the full seat map', async () => {
    const summary = await new Seeder(testDb.db, { bcryptRounds: 4 }).run();
    const expectedSeats = DEMO_EVENTS.reduce((sum, e) => sum + e.seatRows * e.seatsPerRow, 0);
    expect(summary).toEqual({
      users: DEMO_USERS.length,
      venues: 2,
      events: DEMO_EVENTS.length,
      seatCategories: DEMO_EVENTS.reduce((sum, e) => sum + e.categories.length, 0),
      seats: expectedSeats,
    });
    expect(await counts()).toEqual({
      users: summary.users,
      venues: summary.venues,
      events: summary.events,
      categories: summary.seatCategories,
      seats: summary.seats,
    });
  });

  it('stores bcrypt hashes that verify against the documented demo passwords', async () => {
    for (const user of DEMO_USERS) {
      const { rows } = await testDb.db.query<{
        password_hash: string;
        role: string;
        email_verified: boolean;
      }>('SELECT password_hash, role, email_verified FROM users WHERE lower(email) = lower($1)', [
        user.email,
      ]);
      expect(rows[0]!.password_hash).toMatch(/^\$2[aby]\$/);
      expect(rows[0]!.password_hash).not.toContain(user.password);
      expect(await bcrypt.compare(user.password, rows[0]!.password_hash)).toBe(true);
      expect(rows[0]!.role).toBe(user.role);
      expect(rows[0]!.email_verified).toBe(true);
    }
  });

  it('is idempotent: re-running converges without duplicates and keeps events in the future', async () => {
    const before = await counts();
    await new Seeder(testDb.db, { bcryptRounds: 4 }).run();
    expect(await counts()).toEqual(before);
    const { rows } = await testDb.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE start_at <= now()`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('assigns seats to the configured categories and publishes only published events', async () => {
    const vip = await testDb.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM seats s JOIN seat_categories c ON c.id = s.category_id
       WHERE s.event_id = $1 AND c.name = 'VIP'`,
      [DEMO_EVENTS[0]!.id],
    );
    expect(vip.rows[0]!.n).toBe(2 * DEMO_EVENTS[0]!.seatsPerRow);
    const { rows } = await testDb.db.query<{ status: string; published: boolean }>(
      'SELECT status, published_at IS NOT NULL AS published FROM events ORDER BY id',
    );
    expect(rows.every((r) => (r.status === 'PUBLISHED') === r.published)).toBe(true);
  });

  it('removes seats outside a shrunk map but rolls back entirely on invalid data', async () => {
    const event = DEMO_EVENTS[2]!;
    const shrunk = { ...event, seatsPerRow: event.seatsPerRow - 2 };
    await new Seeder(testDb.db, { bcryptRounds: 4, events: [shrunk] }).run();
    const { rows } = await testDb.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM seats WHERE event_id = $1',
      [event.id],
    );
    expect(rows[0]!.n).toBe(shrunk.seatRows * shrunk.seatsPerRow);

    const broken = { ...event, categories: [{ name: 'General', priceMinor: 1, rows: ['A'] }] };
    const before = await counts();
    await expect(
      new Seeder(testDb.db, { bcryptRounds: 4, events: [broken] }).run(),
    ).rejects.toThrow('has no category for row B');
    expect(await counts()).toEqual(before);
  });
});
