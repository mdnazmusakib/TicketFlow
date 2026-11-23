import request from 'supertest';
import {
  createApiHarness,
  STRONG_PASSWORD,
  uniqueEmail,
  type ApiHarness,
} from '../../helpers/apiHarness';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://ticketflow.example.com',
  DATABASE_SSL: 'true',
  JWT_SECRET: 'Zq8vN3kL0pR7tX2wY5bC9dF4gH6jK1mQzA0sD8fG3hJ',
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  PUBLIC_API_URL: 'https://api.ticketflow.example.com',
};

async function register(h: ApiHarness, role: 'CUSTOMER' | 'ORGANIZER' = 'CUSTOMER') {
  const email = uniqueEmail(role.toLowerCase());
  const agent = request.agent(h.app);
  const res = await agent
    .post('/api/auth/register')
    .send({ name: 'Optional User', email, password: STRONG_PASSWORD, role })
    .expect(201);
  return { agent, email, res, userId: res.body.data.user.id as string };
}

async function emailVerified(h: ApiHarness, userId: string): Promise<boolean> {
  const { rows } = await h.testDb.db.query<{ email_verified: boolean }>(
    'SELECT email_verified FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.email_verified;
}

describe('Optional email verification (REQUIRE_EMAIL_VERIFICATION=false, the default)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness(); // real OTP flow, no test bypass
  });

  afterAll(async () => {
    await h.close();
  });

  it('registration signs the user in without an OTP and keeps the account unverified', async () => {
    const { agent, email, res, userId } = await register(h);
    expect(res.body.data).toMatchObject({
      verificationRequired: false,
      user: { email: email.toLowerCase(), emailVerified: false },
    });
    expect(String(res.headers['set-cookie'])).toMatch(/tf_session=.*HttpOnly/i);
    // The OTP is emailed (verification stays available) but never returned by the API.
    const otp = h.emails.lastOtpFor(email);
    expect(JSON.stringify(res.body)).not.toContain(otp);
    expect(await emailVerified(h, userId)).toBe(false);

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.user).toMatchObject({ email: email.toLowerCase(), emailVerified: false });
    await agent.get('/api/dashboard/customer').expect(200);
    await agent.get('/api/bookings').expect(200);
  });

  it('existing unverified and verified users can both sign in; the password is still checked', async () => {
    const unverified = await register(h);
    const verified = await register(h);
    await h.testDb.db.query(
      'UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1',
      [verified.userId],
    );

    for (const { email } of [unverified, verified]) {
      const login = await request(h.app)
        .post('/api/auth/login')
        .send({ email, password: STRONG_PASSWORD })
        .expect(200);
      expect(String(login.headers['set-cookie'])).toMatch(/tf_session=/);
      const wrong = await request(h.app)
        .post('/api/auth/login')
        .send({ email, password: 'Wrong!Passw0rd' })
        .expect(401);
      expect(wrong.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    expect(await emailVerified(h, unverified.userId)).toBe(false);
  });

  it('disabled accounts are still denied, verified or not', async () => {
    const { email, userId, agent } = await register(h);
    await h.testDb.db.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
    const res = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
    // The session issued at registration stops working immediately.
    await agent.get('/api/auth/me').expect(401);
  });

  it('unverified accounts get no extra privileges', async () => {
    const organizer = await register(h, 'ORGANIZER');
    await organizer.agent.get('/api/organizer/events').expect(200);
    await organizer.agent.get('/api/admin/overview').expect(403);
    const customer = await register(h);
    await customer.agent.get('/api/organizer/events').expect(403);
    await customer.agent.get('/api/admin/users').expect(403);
    // ADMIN can never be self-registered.
    await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'X', email: uniqueEmail('adm'), password: STRONG_PASSWORD, role: 'ADMIN' })
      .expect(400);
  });

  it('users can still verify their email voluntarily, and resend never leaks the code', async () => {
    const { email, userId, agent } = await register(h);
    const resend = await request(h.app).post('/api/auth/resend-otp').send({ email });
    expect([202, 429]).toContain(resend.status); // cooldown may apply right after signup
    expect(JSON.stringify(resend.body)).not.toMatch(/\b\d{6}\b/);
    const otp = h.emails.lastOtpFor(email);
    await agent.post('/api/auth/verify-otp').send({ email, otp }).expect(200);
    expect(await emailVerified(h, userId)).toBe(true);
  });

  it('a failing mail server does not block registration', async () => {
    jest.spyOn(h.emails, 'send').mockRejectedValueOnce(new Error('SMTP down'));
    const { res } = await register(h);
    expect(res.body.data.verificationRequired).toBe(false);
    jest.restoreAllMocks();
  });
});

describe('Re-enabling mandatory verification (REQUIRE_EMAIL_VERIFICATION=true)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ env: { REQUIRE_EMAIL_VERIFICATION: 'true' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('blocks unverified sign-in and sessions, then allows them after OTP verification', async () => {
    const email = uniqueEmail('mandatory');
    const reg = await request(h.app)
      .post('/api/auth/register')
      .send({ name: 'Mandatory User', email, password: STRONG_PASSWORD, role: 'CUSTOMER' })
      .expect(201);
    expect(reg.body.data.verificationRequired).toBe(true);
    expect(reg.headers['set-cookie']).toBeUndefined();
    const blocked = await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD })
      .expect(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await request(h.app)
      .post('/api/auth/verify-otp')
      .send({ email, otp: h.emails.lastOtpFor(email) })
      .expect(200);
    await request(h.app)
      .post('/api/auth/login')
      .send({ email, password: STRONG_PASSWORD })
      .expect(200);
  });
});

describe('Optional verification in production', () => {
  it('the test bypass is ignored but users are signed in and stay unverified', async () => {
    const h = await createApiHarness({ env: PRODUCTION_ENV, otpBypass: true });
    try {
      const { res, userId } = await register(h);
      expect(res.body.data).toMatchObject({
        verificationRequired: false,
        user: { emailVerified: false },
      });
      expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
      expect(await emailVerified(h, userId)).toBe(false);
    } finally {
      await h.close();
    }
  });
});
