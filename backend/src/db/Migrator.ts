import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

/** Resolves to backend/db/migrations from both src/db and dist/db. */
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'db', 'migrations');

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant: serialises concurrent migration runs (e.g. two deploys).
const MIGRATION_LOCK_KEY = 727_311_001;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  applied: { version: string; name: string; appliedAt: Date }[];
  pending: { version: string; name: string }[];
}

export class MigrationChecksumError extends Error {
  constructor(public readonly version: string) {
    super(`Migration ${version} was modified after being applied. Create a new migration instead.`);
    this.name = 'MigrationChecksumError';
  }
}

export async function loadMigrationFiles(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const filename of entries) {
    const match = MIGRATION_FILE.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename} (expected 0001_name.sql)`);
    const [, version, name] = match as unknown as [string, string, string];
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    // Normalise line endings so checksums match across Windows/Linux checkouts.
    const sql = (await readFile(join(dir, filename), 'utf8')).replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    files.push({ version, name, filename, checksum, sql });
  }
  return files;
}

/**
 * Forward-only SQL migration runner.
 * - Each migration runs in its own transaction with its bookkeeping row.
 * - A session advisory lock prevents concurrent runners.
 * - Applied migrations are checksum-verified to detect edited history.
 */
export class Migrator {
  constructor(
    private readonly pool: Pool,
    private readonly options: { dir?: string; logger?: Logger } = {},
  ) {}

  async migrate(): Promise<string[]> {
    const files = await loadMigrationFiles(this.options.dir);
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await this.ensureTable(client);
      const applied = await this.appliedChecksums(client);
      this.verifyChecksums(files, applied);

      const executed: string[] = [];
      for (const file of files) {
        if (applied.has(file.version)) continue;
        this.options.logger?.info({ migration: file.filename }, 'Applying migration');
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file.filename} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
        executed.push(file.filename);
      }
      return executed;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
      client.release();
    }
  }

  async status(): Promise<MigrationStatus> {
    const files = await loadMigrationFiles(this.options.dir);
    const client = await this.pool.connect();
    try {
      await this.ensureTable(client);
      const { rows } = await client.query<{ version: string; name: string; applied_at: Date }>(
        'SELECT version, name, applied_at FROM public.schema_migrations ORDER BY version',
      );
      const appliedVersions = new Set(rows.map((row) => row.version));
      return {
        applied: rows.map((row) => ({
          version: row.version,
          name: row.name,
          appliedAt: row.applied_at,
        })),
        pending: files
          .filter((file) => !appliedVersions.has(file.version))
          .map((file) => ({ version: file.version, name: file.name })),
      };
    } finally {
      client.release();
    }
  }

  private async ensureTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    VARCHAR(4)   PRIMARY KEY,
        name       VARCHAR(200) NOT NULL,
        checksum   CHAR(64)     NOT NULL,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
      )`);
    // Never exposed through the Supabase Data API.
    await client.query('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON TABLE public.schema_migrations FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON TABLE public.schema_migrations FROM authenticated;
        END IF;
      END $$`);
  }

  private async appliedChecksums(client: PoolClient): Promise<Map<string, string>> {
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations',
    );
    return new Map(rows.map((row) => [row.version, row.checksum]));
  }

  private verifyChecksums(files: MigrationFile[], applied: Map<string, string>): void {
    for (const file of files) {
      const checksum = applied.get(file.version);
      if (checksum && checksum !== file.checksum) throw new MigrationChecksumError(file.version);
    }
  }
}
