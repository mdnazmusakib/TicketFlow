/**
 * Self-contained TicketFlow stack for Playwright end-to-end tests.
 *
 * - Real PostgreSQL (embedded-postgres), migrated and seeded with the demo data
 * - Redis: E2E_REDIS_URL when given, otherwise an in-memory Redis (ioredis-mock)
 * - Real OTP flow (not bypassed): outgoing emails are appended to a JSONL
 *   mailbox file that the tests read
 * - The API also serves the built web app (FRONTEND_DIST_DIR), exactly like the
 *   single-host production deployment
 *
 * Never loads backend/.env: no real credentials are used.
 * Usage: npm run e2e:server -w backend   (after `npm run build -w frontend`)
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { createLogger } from '../../src/config/logger';
import { buildContainer } from '../../src/container';
import { Migrator } from '../../src/db/Migrator';
import { Seeder } from '../../src/db/seed/Seeder';
import type { EmailMessage, EmailSender } from '../../src/domain/notifications/email';
import { Database } from '../../src/infrastructure/database/Database';
import { createRedisClient } from '../../src/infrastructure/redis/client';

const backendDir = path.resolve(__dirname, '..', '..');
const port = Number(process.env.E2E_PORT ?? 4100);
const origin = `http://localhost:${port}`;
const mailbox = path.resolve(
  process.env.E2E_MAILBOX ?? path.join(backendDir, '.tmp', 'e2e-mailbox.jsonl'),
);
const distDir = path.resolve(
  process.env.E2E_FRONTEND_DIST ?? path.join(backendDir, '..', 'frontend', 'dist'),
);

class FileMailbox implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    appendFileSync(mailbox, `${JSON.stringify({ ...message, at: new Date().toISOString() })}\n`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function main(): Promise<void> {
  mkdirSync(path.dirname(mailbox), { recursive: true });
  writeFileSync(mailbox, '');

  const pgPort = await freePort();
  const dataDir = path.join(backendDir, '.embedded-pg', `e2e-${process.pid}-${Date.now()}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    postgresFlags: ['-c', 'io_method=sync'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: String(port),
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'false',
    REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379',
    REDIS_KEY_PREFIX: `e2e${process.pid}:`,
    JWT_SECRET: randomBytes(32).toString('hex'),
    CORS_ORIGINS: origin,
    FRONTEND_URL: origin,
    PUBLIC_API_URL: origin,
    FRONTEND_DIST_DIR: distDir,
    UPLOAD_DIR: path.join(backendDir, '.tmp', 'e2e-uploads'),
    COOKIE_SECURE: 'false',
    BCRYPT_SALT_ROUNDS: '10',
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    BOOKING_RATE_LIMIT_MAX: '100000',
    ENABLE_MOCK_PAYMENTS: 'true',
    EMAIL_TRANSPORT: 'console',
    NOTIFICATION_WORKER_INTERVAL_MS: '2000',
  });
  const logger = createLogger(config);

  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  // Idle clients error when PostgreSQL stops at teardown; that must not crash the process.
  pool.on('error', () => undefined);
  await new Migrator(pool).migrate();
  const db = new Database(pool, logger);
  await new Seeder(db, { bcryptRounds: 10, logger }).run();

  const redis: Redis = process.env.E2E_REDIS_URL
    ? createRedisClient(config.redis, logger)
    : (new RedisMock({ keyPrefix: config.redis.keyPrefix }) as unknown as Redis);

  const container = buildContainer(config, logger, {
    db,
    redis,
    emailSender: new FileMailbox(),
    otpBypass: false,
  });
  await container.start();
  const app = createApp({
    config,
    logger,
    controllers: container.controllers,
    authenticate: container.authenticate,
    rateLimitStore: container.rateLimitStore,
  });
  const server = app.listen(port, () => {
    process.stdout.write(`TicketFlow E2E stack on ${origin} (mailbox: ${mailbox})\n`);
  });
  container.expiryWorker.start();
  container.notificationWorker.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await container.close().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `E2E server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
