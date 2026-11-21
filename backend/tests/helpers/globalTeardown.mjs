import { rm } from 'node:fs/promises';

export default async function globalTeardown() {
  const pg = globalThis.__EMBEDDED_PG__;
  if (!pg) return;
  await pg.stop();
  // Windows may hold file handles briefly after the server exits: retry removal.
  await rm(globalThis.__EMBEDDED_PG_DIR__, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
