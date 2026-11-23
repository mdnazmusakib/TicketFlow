import request from 'supertest';
import { createApp } from '../../../src/app';
import { buildContainer } from '../../../src/container';
import { PROXY_HEADERS, signClientIp } from '../../../src/shared/security/trustedProxy';
import {
  createApiHarness,
  makeAdmin,
  signUp,
  InMemoryEmailSender,
  STRONG_PASSWORD,
  uniqueEmail,
  type ApiHarness,
} from '../../helpers/apiHarness';
import { captureLogger } from '../../helpers/testApp';

const SECRET = 'proxy-secret-for-tests-0123456789abcdef';

/** Remaining requests from the draft-8 RateLimit header ("...; r=12; t=34"). */
function remaining(res: request.Response): number {
  const header = String(res.headers.ratelimit ?? '');
  const match = /r=(\d+)/.exec(header);
  if (!match) throw new Error(`No RateLimit header: ${header}`);
  return Number(match[1]);
}

function signed(ip: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  return {
    [PROXY_HEADERS.clientIp]: ip,
    [PROXY_HEADERS.timestamp]: String(ts),
    [PROXY_HEADERS.signature]: signClientIp(secret, ip, ts),
  };
}

async function registerUser(h: ApiHarness): Promise<string> {
  const email = uniqueEmail('throttle');
  await request(h.app)
    .post('/api/auth/register')
    .send({ name: 'Throttle User', email, password: STRONG_PASSWORD, role: 'CUSTOMER' })
    .expect(201);
  return email;
}

const login = (h: ApiHarness, email: string, password: string, xff?: string) => {
  const req = request(h.app).post('/api/auth/login');
  if (xff) req.set('X-Forwarded-For', xff);
  return req.send({ email, password });
};

describe('Client IP identity behind Render (TRUST_PROXY=1)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ env: { TRUST_PROXY: '1', RATE_LIMIT_MAX: '100' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('spoofed X-Forwarded-For entries do not create a fresh rate-limit identity', async () => {
    // Render's edge appends the real connecting address as the LAST entry; anything a client
    // writes before it is attacker-controlled.
    const real = '203.0.113.7';
    const first = await request(h.app).get('/api/events').set('X-Forwarded-For', real);
    const spoofs = ['9.9.9.9', '9.9.9.9, 8.8.8.8', '1.2.3.4, 5.6.7.8, 10.0.0.1'];
    let previous = remaining(first);
    for (const spoof of spoofs) {
      const res = await request(h.app)
        .get('/api/events')
        .set('X-Forwarded-For', `${spoof}, ${real}`);
      expect(remaining(res)).toBe(previous - 1); // same counter keeps counting down
      previous = remaining(res);
    }
    // A genuinely different client gets its own counter.
    const other = await request(h.app).get('/api/events').set('X-Forwarded-For', '198.51.100.9');
    expect(remaining(other)).toBe(99);
  });

  it('control: trusting more hops than really exist lets spoofed entries pick the identity', async () => {
    const unsafe = await createApiHarness({ env: { TRUST_PROXY: '2', RATE_LIMIT_MAX: '100' } });
    try {
      const a = await request(unsafe.app).get('/api/events').set('X-Forwarded-For', '203.0.113.7');
      const b = await request(unsafe.app)
        .get('/api/events')
        .set('X-Forwarded-For', '9.9.9.9, 8.8.8.8, 203.0.113.7');
      expect(remaining(a)).toBe(99);
      expect(remaining(b)).toBe(99); // fresh counter: why TRUST_PROXY must match the real hop count
    } finally {
      await unsafe.close();
    }
  });
});

describe('Signed client IP from the trusted edge proxy (TRUSTED_PROXY_SECRET)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      env: { TRUST_PROXY: '1', RATE_LIMIT_MAX: '100', TRUSTED_PROXY_SECRET: SECRET },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('uses the signed client IP, so users behind the shared proxy keep separate counters', async () => {
    const proxyEdge = '76.76.21.21'; // the proxy's own address, identical for every user
    const a1 = await request(h.app)
      .get('/api/events')
      .set('X-Forwarded-For', proxyEdge)
      .set(signed('192.0.2.10'));
    const a2 = await request(h.app)
      .get('/api/events')
      .set('X-Forwarded-For', proxyEdge)
      .set(signed('192.0.2.10'));
    const b1 = await request(h.app)
      .get('/api/events')
      .set('X-Forwarded-For', proxyEdge)
      .set(signed('192.0.2.11'));
    expect(remaining(a2)).toBe(remaining(a1) - 1);
    expect(remaining(b1)).toBe(99);
  });

  it('ignores forged, stale or malformed signatures and falls back to the real address', async () => {
    const real = '203.0.113.50';
    const base = await request(h.app).get('/api/events').set('X-Forwarded-For', real);
    const now = Math.floor(Date.now() / 1000);
    const forgeries = [
      signed('192.0.2.99', 'attacker-guessed-secret-0123456789abcdef'),
      signed('192.0.2.98', SECRET, now - 3600), // replayed/stale
      { ...signed('192.0.2.97'), [PROXY_HEADERS.clientIp]: '192.0.2.96' }, // IP swapped
      { [PROXY_HEADERS.clientIp]: '192.0.2.95' }, // unsigned
      { 'X-Vercel-Forwarded-For': '192.0.2.94', 'X-Real-IP': '192.0.2.93' }, // plain headers
    ];
    let previous = remaining(base);
    for (const headers of forgeries) {
      const res = await request(h.app)
        .get('/api/events')
        .set('X-Forwarded-For', real)
        .set(headers as Record<string, string>);
      expect(remaining(res)).toBe(previous - 1);
      previous = remaining(res);
    }
  });
});

describe('Blocking direct API access (REQUIRE_TRUSTED_PROXY=true)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      env: { TRUSTED_PROXY_SECRET: SECRET, REQUIRE_TRUSTED_PROXY: 'true' },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects unsigned requests to protected paths and accepts signed ones', async () => {
    const direct = await request(h.app).get('/api/events').expect(403);
    expect(direct.body.error.message).toMatch(/Direct API access/);
    await request(h.app)
      .post('/api/auth/login')
      .send({ email: 'a@example.com', password: 'x' })
      .expect(403);
    await request(h.app).get('/api/events').set(signed('192.0.2.1')).expect(200);
  });

  it('keeps health checks, payment provider callbacks and images reachable', async () => {
    await request(h.app).get('/api/health/live').expect(200);
    const ipn = await request(h.app)
      .post('/api/payments/webhooks/SSLCOMMERZ')
      .type('form')
      .send({ tran_id: 'x' });
    expect(ipn.body.error?.message ?? '').not.toMatch(/Direct API access/);
    const ret = await request(h.app).post('/api/payments/providers/sslcommerz/return/success');
    expect(ret.body?.error?.message ?? '').not.toMatch(/Direct API access/);
    await request(h.app).get('/uploads/00000000-0000-4000-8000-000000000000.png').expect(404);
  });
});

describe('Per-account and per-IP sign-in throttling', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      env: {
        TRUST_PROXY: '1',
        LOGIN_MAX_ATTEMPTS_PER_EMAIL: '3',
        LOGIN_MAX_ATTEMPTS_PER_IP: '6',
        LOGIN_THROTTLE_WINDOW_SECONDS: '600',
      },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('rotating IP addresses does not bypass the per-account limit', async () => {
    const email = await registerUser(h);
    for (let i = 1; i <= 3; i += 1) {
      await login(h, email, 'Wrong!Passw0rd', `10.0.0.${i}`).expect(401);
    }
    const blocked = await login(h, email, STRONG_PASSWORD, '10.0.0.200').expect(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    // Redis keys never contain the raw email.
    const keys = await h.redis.keys('*login_attempts*');
    expect(keys.join(' ')).not.toContain(email.toLowerCase());
  });

  it('different accounts have independent counters, and unknown emails look the same', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    for (let i = 0; i < 3; i += 1) await login(h, a, 'Wrong!Passw0rd', `10.1.0.${i}`).expect(401);
    await login(h, a, 'Wrong!Passw0rd', '10.1.0.9').expect(429);
    await login(h, b, STRONG_PASSWORD, '10.1.0.10').expect(200);

    const ghost = uniqueEmail('ghost');
    for (let i = 0; i < 3; i += 1)
      await login(h, ghost, 'Wrong!Passw0rd', `10.2.0.${i}`).expect(401);
    const ghostBlocked = await login(h, ghost, 'Wrong!Passw0rd', '10.2.0.9').expect(429);
    const realBlocked = await login(h, a, 'Wrong!Passw0rd', '10.2.0.8').expect(429);
    expect(ghostBlocked.body.error.message).toBe(realBlocked.body.error.message);
  });

  it('a successful sign-in resets the account counter (no lockout for the owner)', async () => {
    const email = await registerUser(h);
    await login(h, email, 'Wrong!Passw0rd', '10.3.0.1').expect(401);
    await login(h, email, 'Wrong!Passw0rd', '10.3.0.2').expect(401);
    await login(h, email, STRONG_PASSWORD, '10.3.0.3').expect(200);
    await login(h, email, 'Wrong!Passw0rd', '10.3.0.4').expect(401);
    await login(h, email, 'Wrong!Passw0rd', '10.3.0.5').expect(401);
    await login(h, email, STRONG_PASSWORD, '10.3.0.6').expect(200);
  });

  it('one IP cannot spray many accounts beyond the per-IP limit', async () => {
    const ip = '10.4.0.1';
    for (let i = 0; i < 6; i += 1) {
      await login(h, uniqueEmail(`spray${i}`), 'Wrong!Passw0rd', ip).expect(401);
    }
    await login(h, uniqueEmail('spray-next'), 'Wrong!Passw0rd', ip).expect(429);
    await login(h, uniqueEmail('spray-other'), 'Wrong!Passw0rd', '10.4.0.2').expect(401);
  });

  it('concurrent attempts cannot race past the limit', async () => {
    const email = await registerUser(h);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        login(h, email, 'Wrong!Passw0rd', `10.5.${i}.1`).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 401)).toHaveLength(3);
    expect(results.filter((s) => s === 429)).toHaveLength(7);
  });

  it('counters are shared by every API instance using the same Redis', async () => {
    const email = await registerUser(h);
    // Second instance: separate container and app, same database and Redis.
    const container2 = buildContainer(h.config, captureLogger().logger, {
      db: h.testDb.db,
      redis: h.redis,
      emailSender: new InMemoryEmailSender(),
      notificationImmediateDelivery: false,
    });
    const app2 = createApp({
      config: h.config,
      logger: captureLogger().logger,
      controllers: container2.controllers,
      authenticate: container2.authenticate,
    });
    try {
      await login(h, email, 'Wrong!Passw0rd', '10.6.0.1').expect(401);
      await request(app2)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.6.0.2')
        .send({ email, password: 'Wrong!Passw0rd' })
        .expect(401);
      await login(h, email, 'Wrong!Passw0rd', '10.6.0.3').expect(401);
      await request(app2)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.6.0.4')
        .send({ email, password: STRONG_PASSWORD })
        .expect(429);
    } finally {
      await container2.expiryWorker.stop();
      await container2.notificationWorker.stop();
    }
  });
});

describe('Registration and OTP resend throttling', () => {
  it('the auth limiter caps registration per client and resend has a per-email cooldown', async () => {
    const h = await createApiHarness({
      env: { TRUST_PROXY: '1', AUTH_RATE_LIMIT_MAX: '3', REQUIRE_EMAIL_VERIFICATION: 'true' },
    });
    try {
      const ip = '10.7.0.1';
      const email = uniqueEmail('reg');
      await request(h.app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ name: 'Reg User', email, password: STRONG_PASSWORD, role: 'CUSTOMER' })
        .expect(201);
      // Immediate resend for the same email: cooldown.
      await request(h.app)
        .post('/api/auth/resend-otp')
        .set('X-Forwarded-For', ip)
        .send({ email })
        .expect(429);
      await request(h.app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', ip)
        .send({
          name: 'Reg User',
          email: uniqueEmail('reg'),
          password: STRONG_PASSWORD,
          role: 'CUSTOMER',
        })
        .expect(201);
      // 4th auth request from the same client: limited, even with spoofed entries in front.
      await request(h.app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', `6.6.6.6, ${ip}`)
        .send({
          name: 'Reg User',
          email: uniqueEmail('reg'),
          password: STRONG_PASSWORD,
          role: 'CUSTOMER',
        })
        .expect(429);
      expect(h.emails.sent.length).toBe(2);
    } finally {
      await h.close();
    }
  });
});

describe('CLIENT_IP_HEADER and the admin request diagnostics', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      otpBypass: true,
      env: { TRUST_PROXY: '3', RATE_LIMIT_MAX: '100', CLIENT_IP_HEADER: 'CF-Connecting-IP' },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('uses the configured edge header and ignores invalid values', async () => {
    const a = await request(h.app).get('/api/events').set('CF-Connecting-IP', '198.51.100.1');
    const a2 = await request(h.app)
      .get('/api/events')
      .set('CF-Connecting-IP', '198.51.100.1')
      .set('X-Forwarded-For', '6.6.6.6, 7.7.7.7, 8.8.8.8, 9.9.9.9');
    expect(remaining(a2)).toBe(remaining(a) - 1);
    const b = await request(h.app).get('/api/events').set('CF-Connecting-IP', '198.51.100.2');
    expect(remaining(b)).toBe(99);
    // Not an IP: falls back to req.ip instead of trusting arbitrary text.
    const junk = await request(h.app).get('/api/events').set('CF-Connecting-IP', 'x-attacker');
    expect(remaining(junk)).toBeLessThan(100);
  });

  it('reports how the API sees the caller, to ADMIN only', async () => {
    await request(h.app).get('/api/admin/diagnostics/request').expect(401);
    const customer = await signUp(h, 'CUSTOMER');
    await customer.agent.get('/api/admin/diagnostics/request').expect(403);

    const admin = await signUp(h, 'CUSTOMER');
    await makeAdmin(h, admin.userId);
    const res = await admin.agent
      .get('/api/admin/diagnostics/request')
      .set('CF-Connecting-IP', '198.51.100.7')
      .set('X-Forwarded-For', '203.0.113.1, 10.0.0.2, 10.0.0.3')
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      clientIp: '198.51.100.7',
      viaTrustedProxy: false,
      expressIp: '203.0.113.1',
      trustProxy: 3,
      headers: {
        'x-forwarded-for': '203.0.113.1, 10.0.0.2, 10.0.0.3',
        'cf-connecting-ip': '198.51.100.7',
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/cookie|authorization|tf_session/i);
  });
});
