import request from 'supertest';
import { RedisKeys } from '../../../src/infrastructure/redis/keys';
import {
  createApiHarness,
  signUp,
  STRONG_PASSWORD,
  uniqueEmail,
  type ApiHarness,
} from '../../helpers/apiHarness';

function sessionCookie(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('tf_session='));
  if (!cookie) throw new Error('No session cookie set');
  return cookie;
}

describe('Auth API (mandatory email verification: REQUIRE_EMAIL_VERIFICATION=true)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ env: { REQUIRE_EMAIL_VERIFICATION: 'true' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('registers, emails an OTP, verifies it and starts an httpOnly cookie session', async () => {
    const email = uniqueEmail('Flow');
    const registered = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Flow User', email, password: STRONG_PASSWORD, role: 'CUSTOMER' })
      .expect(201);

    expect(registered.body.data).toMatchObject({
      verificationRequired: true,
      user: { email: email.toLowerCase(), role: 'CUSTOMER', emailVerified: false },
    });
    expect(registered.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(registered.body)).not.toMatch(/password/i);

    const mail = h.emails.sent.at(-1)!;
    expect(mail.to).toBe(email.toLowerCase());
    const otp = h.emails.lastOtpFor(email);
    expect(otp).toMatch(/^\d{6}$/);

    // The code is stored hashed in Redis, never in plain text.
    const stored = await h.redis.get(RedisKeys.otp(email));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(otp);
    expect(await h.redis.ttl(RedisKeys.otp(email))).toBeGreaterThan(290);

    const verified = await request(h.app)
      .post('/api/auth/verify-otp')
      .send({ email, otp })
      .expect(200);
    const cookie = sessionCookie(verified);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i); // plain-http test env; Secure is forced in production

    const me = await request(h.app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.data.user).toMatchObject({ email: email.toLowerCase(), emailVerified: true });
    expect(me.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects OTP replay after successful verification', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Replay', email, password: STRONG_PASSWORD })
      .expect(201);
    const otp = h.emails.lastOtpFor(email);
    await request(h.app).post('/api/auth/verify-otp').send({ email, otp }).expect(200);
    const replay = await request(h.app).post('/api/auth/verify-otp').send({ email, otp });
    expect(replay.status).toBe(409);
  });

  it('counts wrong codes and burns the code after the attempt limit', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Attempts', email, password: STRONG_PASSWORD })
      .expect(201);
    const otp = h.emails.lastOtpFor(email);
    const wrong = otp === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      const response = await request(h.app)
        .post('/api/auth/verify-otp')
        .send({ email, otp: wrong });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('OTP_INVALID');
    }
    const locked = await request(h.app).post('/api/auth/verify-otp').send({ email, otp });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    // Even the right code no longer works: the user must request a new one.
    const after = await request(h.app).post('/api/auth/verify-otp').send({ email, otp });
    expect(after.body.error.code).toBe('OTP_EXPIRED');
  });

  it('rejects expired codes', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Expiry', email, password: STRONG_PASSWORD })
      .expect(201);
    const otp = h.emails.lastOtpFor(email);
    await h.redis.del(RedisKeys.otp(email)); // simulates the 300 s TTL elapsing
    const response = await request(h.app).post('/api/auth/verify-otp').send({ email, otp });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown and invalidates the previous code on resend', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Resend', email, password: STRONG_PASSWORD })
      .expect(201);
    const first = h.emails.lastOtpFor(email);

    const tooSoon = await request(h.app).post('/api/auth/resend-otp').send({ email });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_COOLDOWN');

    await h.redis.del(RedisKeys.otpCooldown(email));
    await request(h.app).post('/api/auth/resend-otp').send({ email }).expect(202);
    const second = h.emails.lastOtpFor(email);
    if (second !== first) {
      const old = await request(h.app).post('/api/auth/verify-otp').send({ email, otp: first });
      expect(old.body.error.code).toBe('OTP_INVALID');
    }
    await request(h.app).post('/api/auth/verify-otp').send({ email, otp: second }).expect(200);
  });

  it('answers resend identically for unknown emails (no enumeration)', async () => {
    const response = await request(h.app)
      .post('/api/auth/resend-otp')
      .send({ email: uniqueEmail('ghost') })
      .expect(202);
    expect(response.body.data.message).toMatch(/If the account exists/);
  });

  it('rejects duplicate emails case-insensitively and self-registration as ADMIN', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Dup', email, password: STRONG_PASSWORD })
      .expect(201);
    const dup = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Dup', email: email.toUpperCase(), password: STRONG_PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const admin = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Admin', email: uniqueEmail(), password: STRONG_PASSWORD, role: 'ADMIN' });
    expect(admin.status).toBe(400);
  });

  it('validates password strength and input shape', async () => {
    const weak = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Weak', email: uniqueEmail(), password: 'password' });
    expect(weak.status).toBe(400);
    const paths = (weak.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toContain('body.password');

    const extra = await request(h.app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail(), password: 'x', role: 'ADMIN' });
    expect(extra.status).toBe(400);
  });

  it('blocks login until the email is verified', async () => {
    const email = uniqueEmail();
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Unverified', email, password: STRONG_PASSWORD })
      .expect(201);
    const response = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('uses one generic error for unknown email and wrong password', async () => {
    const { email } = await signUp(h, 'CUSTOMER');
    const wrong = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: 'Wrong!Pass1' });
    const unknown = await request(h.app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('nobody'), password: 'Wrong!Pass1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('logs in, and logout revokes the token server-side', async () => {
    const { email } = await signUp(h, 'CUSTOMER');
    const login = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD })
      .expect(200);
    const cookie = sessionCookie(login);

    await request(h.app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    const logout = await request(h.app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    expect(sessionCookie(logout)).toMatch(/Expires=Thu, 01 Jan 1970/);

    // A stolen copy of the old cookie is useless after logout.
    const reused = await request(h.app).get('/api/auth/me').set('Cookie', cookie);
    expect(reused.status).toBe(401);
  });

  it('rejects missing, tampered and forged tokens', async () => {
    expect((await request(h.app).get('/api/auth/me')).status).toBe(401);
    expect(
      (await request(h.app).get('/api/auth/me').set('Cookie', 'tf_session=garbage')).status,
    ).toBe(401);

    const { email } = await signUp(h, 'CUSTOMER');
    const login = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    const token = sessionCookie(login).split(';')[0]!.split('=')[1]!;
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        role: 'ADMIN',
      }),
    ).toString('base64url');
    const forged = await request(h.app)
      .get('/api/auth/me')
      .set('Cookie', `tf_session=${header}.${forgedPayload}.${signature}`);
    expect(forged.status).toBe(401);

    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    expect(
      (await request(h.app).get('/api/auth/me').set('Cookie', `tf_session=${none}`)).status,
    ).toBe(401);
  });

  it('ignores tokens sent anywhere except the cookie', async () => {
    const { email } = await signUp(h, 'CUSTOMER');
    const login = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    const token = sessionCookie(login).split(';')[0]!.split('=')[1]!;
    expect(
      (await request(h.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('locks out deactivated accounts immediately', async () => {
    const { agent, userId } = await signUp(h, 'CUSTOMER');
    await agent.get('/api/auth/me').expect(200);
    await h.testDb.db.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('Auth API (test OTP bypass)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
  });

  afterAll(async () => {
    await h.close();
  });

  it('verifies immediately, signs in, and sends no email', async () => {
    const email = uniqueEmail('bypass');
    const response = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Bot', email, password: STRONG_PASSWORD, role: 'ORGANIZER' })
      .expect(201);
    expect(response.body.data).toMatchObject({
      verificationRequired: false,
      user: { emailVerified: true, role: 'ORGANIZER' },
    });
    expect(sessionCookie(response)).toMatch(/HttpOnly/);
    expect(h.emails.sent).toHaveLength(0);
  });
});
