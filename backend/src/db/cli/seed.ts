import dotenv from 'dotenv';
import { loadConfig } from '../../config/env';
import { createLogger } from '../../config/logger';
import { Database } from '../../infrastructure/database/Database';
import { createPool } from '../../infrastructure/database/pool';
import { assertSeedAllowed } from '../seed/seedGuard';
import { Seeder } from '../seed/Seeder';

/** Usage: npm run db:seed  (run db:migrate first) */
async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const config = loadConfig();
  assertSeedAllowed(config);
  const logger = createLogger(config);
  const db = new Database(createPool(config.database, logger), logger);

  try {
    await new Seeder(db, { bcryptRounds: config.auth.bcryptSaltRounds, logger }).run();
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
