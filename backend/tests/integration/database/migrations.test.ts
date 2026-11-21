import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_DIR, MigrationChecksumError, Migrator, loadMigrationFiles } from '../../../src/db/Migrator';
import { createTestDatabase, type TestDatabase } from '../../helpers/testDatabase';

const EXPECTED_TABLES = [
  'audit_logs',
  'booking_seats',
  'booking_status_history',
  'bookings',
  'events',
  'idempotency_keys',
  'notifications',
  'payment_webhook_events',
  'payments',
  'refunds',
  'schema_migrations',
  'seat_categories',
  'seats',
  'tickets',
  'users',
  'venues',
];

describe('Migrator (real PostgreSQL)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('reports every migration as pending on an empty database', async () => {
    const status = await new Migrator(testDb.pool).status();
    expect(status.applied).toEqual([]);
    expect(status.pending.length).toBe((await loadMigrationFiles()).length);
  });

  it('applies all migrations and creates the documented tables', async () => {
    const executed = await new Migrator(testDb.pool).migrate();
    expect(executed[0]).toBe('0001_extensions_and_functions.sql');

    const { rows } = await testDb.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await new Migrator(testDb.pool).migrate()).toEqual([]);
    const status = await new Migrator(testDb.pool).status();
    expect(status.pending).toEqual([]);
    expect(status.applied.map((m) => m.version)).toContain('0006');
  });

  it('enables row level security on every application table', async () => {
    const { rows } = await testDb.pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(rows.length).toBe(EXPECTED_TABLES.length);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('creates the double-booking partial unique index', async () => {
    const { rows } = await testDb.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_active_seat_per_event'`,
    );
    expect(rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(event_id, seat_id\) WHERE .*HELD.*BOOKED/);
  });

  it('serialises concurrent runners with an advisory lock', async () => {
    const fresh = await createTestDatabase();
    try {
      const results = await Promise.all([new Migrator(fresh.pool).migrate(), new Migrator(fresh.pool).migrate()]);
      const total = results[0].length + results[1].length;
      expect(total).toBe((await loadMigrationFiles()).length);
    } finally {
      await fresh.drop();
    }
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tf-migrations-'));
    try {
      await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
      await appendFile(join(dir, '0001_extensions_and_functions.sql'), '\n-- edited\n');
      await expect(new Migrator(testDb.pool, { dir }).migrate()).rejects.toBeInstanceOf(MigrationChecksumError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration and leaves earlier ones applied', async () => {
    const fresh = await createTestDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'tf-migrations-'));
    try {
      await cp(join(DEFAULT_MIGRATIONS_DIR, '0001_extensions_and_functions.sql'), join(dir, '0001_extensions_and_functions.sql'));
      await writeFile(join(dir, '0002_broken.sql'), 'CREATE TABLE ok_table (id int);\nSELECT * FROM missing_table;\n');
      await expect(new Migrator(fresh.pool, { dir }).migrate()).rejects.toThrow('Migration 0002_broken.sql failed');

      const status = await new Migrator(fresh.pool, { dir }).status();
      expect(status.applied.map((m) => m.version)).toEqual(['0001']);
      const { rows } = await fresh.pool.query(`SELECT to_regclass('public.ok_table') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it('rejects badly named migration files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tf-migrations-'));
    try {
      await writeFile(join(dir, 'init.sql'), 'SELECT 1;');
      await expect(loadMigrationFiles(dir)).rejects.toThrow('Invalid migration filename');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
