import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import request from 'supertest';
import { createApp } from '../../../src/app';
import { HealthController } from '../../../src/controllers/HealthController';
import { PostgresHealthProbe, RedisHealthProbe } from '../../../src/repositories/HealthProbes';
import { HealthService } from '../../../src/services/HealthService';
import { captureLogger, testConfig } from '../../helpers/testApp';
import { createTestDatabase, type TestDatabase } from '../../helpers/testDatabase';

describe('Health API (real PostgreSQL + Redis mock)', () => {
  let testDb: TestDatabase;
  let redis: Redis;

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: true });
    redis = new RedisMock() as unknown as Redis;
  });

  afterAll(async () => {
    redis.disconnect();
    await testDb.drop();
  });

  function buildApp(
    overrides: Record<string, string> = {},
    redisClient: Pick<Redis, 'ping'> = redis,
  ) {
    const config = testConfig(overrides);
    const healthService = new HealthService(
      [new PostgresHealthProbe(testDb.db), new RedisHealthProbe(redisClient)],
      { timeoutMs: 2_000, version: '0.1.0', startedAt: new Date() },
    );
    return createApp({
      config,
      logger: captureLogger().logger,
      controllers: { health: new HealthController(healthService) },
    });
  }

  it('GET /api/health/live returns liveness without touching dependencies', async () => {
    const response = await request(buildApp()).get('/api/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'ok', version: '0.1.0' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/health/ready reports PostgreSQL and Redis up', async () => {
    const response = await request(buildApp()).get('/api/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.checks.database).toMatchObject({
      status: 'up',
      details: { schemaVersion: '0006' },
    });
    expect(response.body.data.checks.redis).toMatchObject({ status: 'up' });
    expect((await request(buildApp()).get('/api/health')).status).toBe(200);
  });

  it('returns 503 when a dependency is down', async () => {
    const failingRedis = {
      ping: () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    };
    const response = await request(buildApp({}, failingRedis as never)).get('/api/health/ready');
    expect(response.status).toBe(503);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      status: 'unavailable',
      checks: {
        database: { status: 'up' },
        redis: { status: 'down', error: 'unreachable (ECONNREFUSED)' },
      },
    });
  });

  it('sets security headers and hides the framework', async () => {
    const response = await request(buildApp()).get('/api/health/live');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('enforces the CORS allowlist', async () => {
    const app = buildApp();
    const allowed = await request(app)
      .get('/api/health/live')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app)
      .get('/api/health/live')
      .set('Origin', 'https://evil.example.com');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CORS_ORIGIN_DENIED');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for allowed origins', async () => {
    const response = await request(buildApp())
      .options('/api/health/live')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Idempotency-Key');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('Idempotency-Key');
  });

  it('rate limits API routes but never health probes', async () => {
    const app = buildApp({ RATE_LIMIT_MAX: '1' });
    expect((await request(app).get('/api/unknown')).status).toBe(404);
    expect((await request(app).get('/api/unknown')).status).toBe(429);
    for (let i = 0; i < 3; i += 1)
      expect((await request(app).get('/api/health/live')).status).toBe(200);
  });

  it('returns the standard JSON error for unknown routes', async () => {
    const response = await request(buildApp()).get('/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /does-not-exist not found',
        requestId: expect.any(String),
      },
    });
  });

  it('enables HSTS in production', async () => {
    const app = buildApp({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://ticketflow.example.com',
      DATABASE_SSL: 'true',
      JWT_SECRET: 'Zq8vN3kL0pR7tX2wY5bC9dF4gH6jK1mQzA0sD8fG3hJ',
    });
    const response = await request(app).get('/api/health/live');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});
