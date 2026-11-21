import dotenv from 'dotenv';
import { loadConfig } from '../../config/env';
import { createLogger } from '../../config/logger';
import { createPool } from '../../infrastructure/database/pool';
import { Migrator } from '../Migrator';

/** Usage: npm run db:migrate [-- --status] */
async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config.database, logger);
  const migrator = new Migrator(pool, { logger });

  try {
    if (process.argv.includes('--status')) {
      const status = await migrator.status();
      for (const m of status.applied) logger.info(`applied  ${m.version}_${m.name}`);
      for (const m of status.pending) logger.info(`pending  ${m.version}_${m.name}`);
      return;
    }
    const executed = await migrator.migrate();
    logger.info(
      executed.length > 0 ? { executed } : {},
      executed.length > 0 ? `Applied ${executed.length} migration(s)` : 'Database already up to date',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
