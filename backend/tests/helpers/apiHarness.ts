import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { buildContainer } from '../../src/container';
import type { EmailMessage, EmailSender } from '../../src/domain/notifications/email';
import { captureLogger, testConfig } from './testApp';
import { createTestDatabase, type TestDatabase } from './testDatabase';

/** Captures outgoing emails so tests can read OTPs. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastOtpFor(email: string): string {
    const message = [...this.sent].reverse().find((m) => m.to === email.toLowerCase());
    const code = message?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`No OTP email for ${email}`);
    return code;
  }
}

export interface ApiHarness {
  app: Express;
  testDb: TestDatabase;
  redis: Redis;
  emails: InMemoryEmailSender;
  close(): Promise<void>;
}

let redisDb = 0;

/** Full app on a fresh migrated PostgreSQL database + an isolated in-memory Redis. */
export async function createApiHarness(
  options: { otpBypass?: boolean; env?: Record<string, string> } = {},
): Promise<ApiHarness> {
  const testDb = await createTestDatabase({ migrate: true });
  // Distinct keyPrefix keeps ioredis-mock instances (which share data) isolated per harness.
  redisDb += 1;
  const config = testConfig({
    REDIS_KEY_PREFIX: `h${process.pid}x${redisDb}:`,
    AUTH_RATE_LIMIT_MAX: '10000',
    RATE_LIMIT_MAX: '10000',
    ...options.env,
  });
  const redis = new RedisMock({ keyPrefix: config.redis.keyPrefix }) as unknown as Redis;
  const emails = new InMemoryEmailSender();
  const container = buildContainer(config, captureLogger().logger, {
    db: testDb.db,
    redis,
    emailSender: emails,
    otpBypass: options.otpBypass ?? false,
  });
  const app = createApp({
    config,
    logger: captureLogger().logger,
    controllers: container.controllers,
    authenticate: container.authenticate,
  });
  return {
    app,
    testDb,
    redis,
    emails,
    async close() {
      redis.disconnect();
      await testDb.drop();
    },
  };
}

export const STRONG_PASSWORD = 'Str0ng!Passw0rd';

let userCounter = 0;
export function uniqueEmail(prefix = 'user'): string {
  userCounter += 1;
  return `${prefix}.${process.pid}.${Date.now()}.${userCounter}@example.com`;
}

/** Registers + verifies via the real OTP flow and returns a cookie-carrying agent. */
export async function signUp(
  harness: ApiHarness,
  role: 'CUSTOMER' | 'ORGANIZER',
  email = uniqueEmail(role.toLowerCase()),
): Promise<{ agent: TestAgent; email: string; userId: string }> {
  const agent = request.agent(harness.app);
  const registered = await agent
    .post('/api/auth/register')
    .send({ name: `${role} Tester`, email, password: STRONG_PASSWORD, role })
    .expect(201);
  if (registered.body.data.verificationRequired) {
    await agent
      .post('/api/auth/verify-otp')
      .send({ email, otp: harness.emails.lastOtpFor(email) })
      .expect(200);
  }
  return { agent, email, userId: registered.body.data.user.id as string };
}

/** Promotes a user to ADMIN directly in the database (admins are never self-registered). */
export async function makeAdmin(harness: ApiHarness, userId: string): Promise<void> {
  await harness.testDb.db.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [userId]);
}
