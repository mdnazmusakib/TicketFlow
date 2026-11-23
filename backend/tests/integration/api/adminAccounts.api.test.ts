import request from 'supertest';
import { BcryptPasswordHasher } from '../../../src/infrastructure/security/PasswordHasher';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { AdminAccountService } from '../../../src/services/admin/AdminAccountService';
import { DEMO_USERS } from '../../../src/db/seed/seedData';
import {
  createApiHarness,
  signUp,
  STRONG_PASSWORD,
  type ApiHarness,
} from '../../helpers/apiHarness';

describe('Admin account administration (operator CLI service)', () => {
  let h: ApiHarness;
  let admins: AdminAccountService;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
    admins = new AdminAccountService(
      h.testDb.db,
      new UserRepository(h.testDb.db),
      new BcryptPasswordHasher(4),
    );
  });

  afterAll(async () => {
    await h.close();
  });

  const loginStatus = (email: string, password: string) =>
    request(h.app).post('/api/auth/login').send({ email, password });

  it('the demo seed no longer contains an admin account', () => {
    expect(DEMO_USERS.some((u) => u.role === 'ADMIN' || /admin/i.test(u.email))).toBe(false);
  });

  it('promotes an existing account, rotates its password, and never returns secrets', async () => {
    const { email, agent } = await signUp(h, 'CUSTOMER');
    await agent.get('/api/admin/overview').expect(403);

    const promoted = await admins.promote(email);
    expect(promoted).toEqual({
      email: email.toLowerCase(),
      name: expect.any(String),
      active: true,
      emailVerified: true,
    });
    expect(JSON.stringify(await admins.listAdmins())).not.toMatch(/password|hash/i);
    await agent.get('/api/admin/overview').expect(200); // role is read from the DB per request

    await expect(admins.setPassword(email, 'weak')).rejects.toMatchObject({ statusCode: 400 });
    const next = 'N3w!AdminPassw0rd';
    await admins.setPassword(email, next);
    expect((await loginStatus(email, STRONG_PASSWORD)).status).toBe(401);
    expect((await loginStatus(email, next)).status).toBe(200);
  });

  it('refuses to deactivate the last active admin, then deactivates once another exists', async () => {
    // Make sure exactly one admin is active.
    await h.testDb.db.query(`UPDATE users SET is_active = false WHERE role = 'ADMIN'`);
    const first = await signUp(h, 'CUSTOMER');
    await admins.promote(first.email);
    await expect(admins.setActive(first.email, false)).rejects.toMatchObject({ statusCode: 409 });

    const second = await signUp(h, 'CUSTOMER');
    await admins.promote(second.email);
    const deactivated = await admins.setActive(first.email, false);
    expect(deactivated.active).toBe(false);
    await first.agent.get('/api/auth/me').expect(401); // existing session stops working
    expect((await loginStatus(first.email, STRONG_PASSWORD)).status).toBe(403);

    await admins.setActive(first.email, true);
    expect((await loginStatus(first.email, STRONG_PASSWORD)).status).toBe(200);
  });

  it('unknown accounts are reported, not created', async () => {
    await expect(admins.promote('nobody@example.com')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('there is no HTTP route that changes roles; registration cannot request ADMIN', async () => {
    const { agent, userId } = await signUp(h, 'CUSTOMER');
    for (const [method, path] of [
      ['patch', `/api/admin/users/${userId}`],
      ['post', `/api/admin/users/${userId}/role`],
      ['patch', '/api/auth/me'],
    ] as const) {
      const res = await agent[method](path).send({ role: 'ADMIN' });
      expect([403, 404]).toContain(res.status);
    }
    const { rows } = await h.testDb.db.query<{ role: string }>(
      'SELECT role FROM users WHERE id = $1',
      [userId],
    );
    expect(rows[0]!.role).toBe('CUSTOMER');
  });
});
