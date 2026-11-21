// Starts a throwaway real PostgreSQL (embedded-postgres) for integration tests,
// unless TEST_DATABASE_URL points at an existing server (e.g. CI service / Supabase branch).
import EmbeddedPostgres from 'embedded-postgres';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export default async function globalSetup() {
  if (process.env.TEST_DATABASE_URL) return;

  const port = await freePort();
  const baseDir = join(here, '..', '..', '.embedded-pg');
  mkdirSync(baseDir, { recursive: true });
  const databaseDir = join(baseDir, `jest-${process.pid}-${Date.now()}`);
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true, // directory is removed by globalTeardown (with Windows-safe retries)
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();

  globalThis.__EMBEDDED_PG__ = pg;
  globalThis.__EMBEDDED_PG_DIR__ = databaseDir;
  process.env.TEST_DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}
