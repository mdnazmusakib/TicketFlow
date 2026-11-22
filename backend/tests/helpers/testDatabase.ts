import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Database } from '../../src/infrastructure/database/Database';
import { Migrator } from '../../src/db/Migrator';

export interface TestDatabase {
  url: string;
  pool: Pool;
  db: Database;
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (globalSetup should provide it)');
  return url;
}

/**
 * Creates an isolated, uniquely named database on the test server so test
 * files can run in parallel without sharing state. Optionally migrates it.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `tf_test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl(), max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 10 });
  const db = new Database(pool);

  if (options.migrate) await new Migrator(pool).migrate();

  return {
    url: url.toString(),
    pool,
    db,
    async drop() {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl(), max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
