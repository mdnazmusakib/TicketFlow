import request from 'supertest';
import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://ticketflow.example.com',
  DATABASE_SSL: 'true',
  JWT_SECRET: 'Zq8vN3kL0pR7tX2wY5bC9dF4gH6jK1mQzA0sD8fG3hJ',
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
};

describe('Health API (real PostgreSQL + Redis mock)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('GET /api/health/live returns liveness without touching dependencies', async () => {
    const response = await request(h.app).get('/api/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/health/ready reports PostgreSQL and Redis up', async () => {
    const response = await request(h.app).get('/api/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.checks.database).toMatchObject({
      status: 'up',
      details: { schemaVersion: '0007' },
    });
    expect(response.body.data.checks.redis).toMatchObject({ status: 'up' });
    expect((await request(h.app).get('/api/health')).status).toBe(200);
  });

  it('returns 503 when a dependency is down', async () => {
    const spy = jest
      .spyOn(h.redis, 'ping')
      .mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    const response = await request(h.app).get('/api/health/ready');
    spy.mockRestore();
    expect(response.status).toBe(503);
    expect(response.body.data).toMatchObject({
      status: 'unavailable',
      checks: {
        database: { status: 'up' },
        redis: { status: 'down', error: 'unreachable (ECONNREFUSED)' },
      },
    });
  });

  it('sets security headers and hides the framework', async () => {
    const response = await request(h.app).get('/api/health/live');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('enforces the CORS allowlist', async () => {
    const allowed = await request(h.app)
      .get('/api/health/live')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(h.app)
      .get('/api/health/live')
      .set('Origin', 'https://evil.example.com');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CORS_ORIGIN_DENIED');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for allowed origins', async () => {
    const response = await request(h.app)
      .options('/api/health/live')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Idempotency-Key');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('Idempotency-Key');
  });

  it('returns the standard JSON error for unknown routes', async () => {
    const response = await request(h.app).get('/does-not-exist');
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
});

describe('Rate limiting and production hardening', () => {
  it('rate limits API routes (not health probes) and auth endpoints more strictly', async () => {
    const h = await createApiHarness({ env: { RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_MAX: '1' } });
    try {
      expect((await request(h.app).get('/api/unknown')).status).toBe(404);
      expect((await request(h.app).get('/api/unknown')).status).toBe(404);
      expect((await request(h.app).get('/api/unknown')).status).toBe(429);
      for (let i = 0; i < 3; i += 1)
        expect((await request(h.app).get('/api/health/live')).status).toBe(200);
    } finally {
      await h.close();
    }

    const auth = await createApiHarness({ env: { AUTH_RATE_LIMIT_MAX: '1' } });
    try {
      const body = { email: 'nobody@example.com', password: 'whatever' };
      expect((await request(auth.app).post('/api/auth/login').send(body)).status).toBe(401);
      const limited = await request(auth.app).post('/api/auth/login').send(body);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await auth.close();
    }
  });

  it('enables HSTS and Secure cookies in production', async () => {
    const h = await createApiHarness({ env: PRODUCTION_ENV, otpBypass: true });
    try {
      const response = await request(h.app).get('/api/health/live');
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');

      // OTP bypass requested by the test is ignored in production: verification stays mandatory.
      const registered = await request(h.app)
        .post('/api/auth/register')
        .send({ name: 'Prod User', email: 'prod.user@example.com', password: 'Str0ng!Passw0rd' })
        .expect(201);
      expect(registered.body.data.verificationRequired).toBe(true);
      const otp = h.emails.lastOtpFor('prod.user@example.com');
      const verified = await request(h.app)
        .post('/api/auth/verify-otp')
        .send({ email: 'prod.user@example.com', otp })
        .expect(200);
      expect(String(verified.headers['set-cookie'])).toMatch(/; Secure/);
    } finally {
      await h.close();
    }
  });
});
