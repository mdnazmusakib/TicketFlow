import { createApiHarness, type ApiHarness } from '../helpers/apiHarness';
import { defineBookingConcurrencySuite } from '../helpers/bookingConcurrencySuite';

/**
 * Same scenarios as the integration suite, but against a REAL Redis server
 * (TEST_REDIS_URL) and real PostgreSQL. Run with: npm run test:concurrency
 */
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('TEST_REDIS_URL is required (run via npm run test:concurrency)');

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ otpBypass: true, redisUrl });
  expect(h.realRedis).toBe(true);
  expect(await h.redis.ping()).toBe('PONG');
});

afterAll(async () => {
  await h.close();
});

defineBookingConcurrencySuite('PostgreSQL + real Redis', () => h);
