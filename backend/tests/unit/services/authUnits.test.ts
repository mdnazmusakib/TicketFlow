import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { RedisTtlStore } from '../../../src/infrastructure/redis/TtlStore';
import { RedisKeys } from '../../../src/infrastructure/redis/keys';
import { ConsoleEmailSender } from '../../../src/infrastructure/email/ConsoleEmailSender';
import { BcryptPasswordHasher } from '../../../src/infrastructure/security/PasswordHasher';
import { createAuthenticate, getAuth, requireRole } from '../../../src/middlewares/auth';
import { OtpService } from '../../../src/services/auth/OtpService';
import { TokenService } from '../../../src/services/auth/TokenService';
import { canManageResource, isRole } from '../../../src/domain/auth/roles';
import { otpEmail } from '../../../src/domain/notifications/email';
import { ForbiddenError, UnauthorizedError } from '../../../src/shared/errors/AppError';

let prefixCounter = 0;
function newStore(): { store: RedisTtlStore; redis: Redis } {
  prefixCounter += 1;
  const keyPrefix = `unit${process.pid}a${prefixCounter}:`;
  const redis = new RedisMock({ keyPrefix }) as unknown as Redis;
  return { store: new RedisTtlStore(redis, keyPrefix), redis };
}

const SECRET = 'unit-test-secret-0123456789abcdefghijkl';

describe('OtpService', () => {
  const email = 'Person@Example.com';
  const options = { ttlSeconds: 300, maxAttempts: 3, resendCooldownSeconds: 60, secret: SECRET };

  it('issues 6-digit codes stored as HMAC with the TTL', async () => {
    const { store, redis } = newStore();
    const otp = new OtpService(store, options);
    const code = await otp.issue(email);
    expect(code).toMatch(/^\d{6}$/);
    const stored = await redis.get(RedisKeys.otp(email));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(await redis.ttl(RedisKeys.otp(email))).toBeGreaterThan(295);
  });

  it('verifies once (replay-safe) and is case-insensitive on email', async () => {
    const { store } = newStore();
    const otp = new OtpService(store, options);
    const code = await otp.issue(email);
    expect(await otp.verify('person@example.com', code)).toBe('VALID');
    expect(await otp.verify(email, code)).toBe('EXPIRED');
  });

  it('lets only one of two concurrent correct submissions win', async () => {
    const { store } = newStore();
    const otp = new OtpService(store, options);
    const code = await otp.issue(email);
    const results = await Promise.all([otp.verify(email, code), otp.verify(email, code)]);
    expect(results.filter((r) => r === 'VALID')).toHaveLength(1);
  });

  it('burns the code after too many wrong attempts', async () => {
    const { store } = newStore();
    const otp = new OtpService(store, options);
    const code = await otp.issue(email);
    const wrong = code === '123456' ? '654321' : '123456';
    expect(await otp.verify(email, wrong)).toBe('INVALID');
    expect(await otp.verify(email, wrong)).toBe('INVALID');
    expect(await otp.verify(email, wrong)).toBe('INVALID');
    expect(await otp.verify(email, code)).toBe('ATTEMPTS_EXCEEDED');
    expect(await otp.verify(email, code)).toBe('EXPIRED');
  });

  it('expires codes when the TTL passes', async () => {
    const { store } = newStore();
    const otp = new OtpService(store, { ...options, ttlSeconds: 1 });
    const code = await otp.issue(email);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await otp.verify(email, code)).toBe('EXPIRED');
  });

  it('enforces the resend cooldown and resets attempts on a new code', async () => {
    const { store, redis } = newStore();
    const otp = new OtpService(store, options);
    const first = await otp.issue(email);
    await expect(otp.issue(email)).rejects.toMatchObject({ statusCode: 429, code: 'OTP_COOLDOWN' });
    await otp.verify(email, first === '000001' ? '000002' : '000001');
    await redis.del(RedisKeys.otpCooldown(email));
    const second = await otp.issue(email);
    expect(await redis.get(RedisKeys.otpAttempts(email))).toBeNull();
    expect(await otp.verify(email, second)).toBe('VALID');
  });
});

describe('TokenService', () => {
  it('issues and verifies HS256 tokens carrying subject, role and jti', async () => {
    const { store } = newStore();
    const tokens = new TokenService(store, { secret: SECRET, expiresIn: '1h' });
    const { token, expiresAt } = tokens.issue({ id: 'u1', role: 'ORGANIZER' });
    const claims = await tokens.verify(token);
    expect(claims).toMatchObject({ userId: 'u1', role: 'ORGANIZER' });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 3_600_000))).toBeLessThan(5_000);
  });

  it('rejects wrong secrets, expired tokens, alg=none and bad roles', async () => {
    const { store } = newStore();
    const tokens = new TokenService(store, { secret: SECRET, expiresIn: '1h' });
    const opts = {
      issuer: 'ticketflow-api',
      audience: 'ticketflow-web',
      subject: 'u1',
      jwtid: 'j1',
    };

    const otherSecret = jwt.sign({ role: 'ADMIN' }, 'another-secret-another-secret-123', opts);
    await expect(tokens.verify(otherSecret)).rejects.toBeInstanceOf(UnauthorizedError);

    const expired = jwt.sign(
      { role: 'CUSTOMER', exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
      opts,
    );
    await expect(tokens.verify(expired)).rejects.toBeInstanceOf(UnauthorizedError);

    const none = jwt.sign({ role: 'ADMIN' }, '', { ...opts, algorithm: 'none' });
    await expect(tokens.verify(none)).rejects.toBeInstanceOf(UnauthorizedError);

    const badRole = jwt.sign({ role: 'ROOT' }, SECRET, { ...opts, expiresIn: '1h' });
    await expect(tokens.verify(badRole)).rejects.toBeInstanceOf(UnauthorizedError);

    const wrongAudience = jwt.sign({ role: 'CUSTOMER' }, SECRET, {
      ...opts,
      audience: 'other',
      expiresIn: '1h',
    });
    await expect(tokens.verify(wrongAudience)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('revokes tokens until they expire', async () => {
    const { store, redis } = newStore();
    const tokens = new TokenService(store, { secret: SECRET, expiresIn: '1h' });
    const { token } = tokens.issue({ id: 'u1', role: 'CUSTOMER' });
    const claims = await tokens.verify(token);
    await tokens.revoke(claims);
    await expect(tokens.verify(token)).rejects.toThrow('signed out');
    expect(await redis.ttl(RedisKeys.revokedToken(claims.jti))).toBeGreaterThan(3_500);
    // Already-expired tokens need no denylist entry.
    await tokens.revoke({ jti: 'old', expiresAt: new Date(Date.now() - 1000) });
    expect(await redis.exists(RedisKeys.revokedToken('old'))).toBe(0);
  });
});

describe('BcryptPasswordHasher', () => {
  it('hashes with salt and verifies', async () => {
    const hasher = new BcryptPasswordHasher(10);
    const hash = await hasher.hash('Str0ng!Pass');
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hash).not.toBe(await hasher.hash('Str0ng!Pass'));
    expect(await hasher.verify('Str0ng!Pass', hash)).toBe(true);
    expect(await hasher.verify('wrong', hash)).toBe(false);
    await expect(hasher.verifyDummy('anything')).resolves.toBeUndefined();
  });
});

describe('auth middleware', () => {
  const run = (handler: ReturnType<typeof requireRole>, req: Record<string, unknown>) =>
    new Promise<unknown>((resolve) =>
      handler(req as never, {} as never, (err?: unknown) => resolve(err)),
    );

  it('requireRole allows listed roles, 403 otherwise, 401 without auth', async () => {
    const auth = (role: string) => ({ auth: { actor: { id: 'u', role } } });
    expect(await run(requireRole('ORGANIZER', 'ADMIN'), auth('ORGANIZER'))).toBeUndefined();
    expect(await run(requireRole('ORGANIZER'), auth('CUSTOMER'))).toBeInstanceOf(ForbiddenError);
    expect(await run(requireRole('ORGANIZER'), {})).toBeInstanceOf(UnauthorizedError);
  });

  it('authenticate reads only the named cookie', async () => {
    const authService = {
      authenticate: jest.fn().mockResolvedValue({ actor: { id: 'u', role: 'CUSTOMER' } }),
    };
    const mw = createAuthenticate(authService as never, 'tf_session');
    expect(await run(mw, { cookies: {} })).toBeInstanceOf(UnauthorizedError);
    expect(
      await run(mw, { cookies: { other: 'x' }, headers: { authorization: 'Bearer x' } }),
    ).toBeInstanceOf(UnauthorizedError);
    const req: Record<string, unknown> = { cookies: { tf_session: 'token' } };
    expect(await run(mw, req)).toBeUndefined();
    expect(authService.authenticate).toHaveBeenCalledWith('token');
    expect(getAuth(req as never).actor.id).toBe('u');

    authService.authenticate.mockRejectedValueOnce(new UnauthorizedError('bad'));
    expect(await run(mw, { cookies: { tf_session: 'bad' } })).toBeInstanceOf(UnauthorizedError);
    expect(() => getAuth({})).toThrow(UnauthorizedError);
  });
});

describe('roles and email helpers', () => {
  it('ownership: owner or admin only', () => {
    expect(canManageResource({ id: 'a', role: 'ORGANIZER' }, 'a')).toBe(true);
    expect(canManageResource({ id: 'b', role: 'ORGANIZER' }, 'a')).toBe(false);
    expect(canManageResource({ id: 'x', role: 'ADMIN' }, 'a')).toBe(true);
    expect(isRole('ADMIN')).toBe(true);
    expect(isRole('admin')).toBe(false);
  });

  it('builds an escaped OTP email and prints it in the dev console mailbox', async () => {
    const mail = otpEmail({ name: '<Bob>', code: '123456', ttlMinutes: 5 });
    expect(mail.text).toContain('123456');
    expect(mail.html).toContain('&#60;Bob&#62;');
    const lines: string[] = [];
    await new ConsoleEmailSender('TicketFlow <no-reply@x.test>', (t) => lines.push(t)).send({
      to: 'a@b.co',
      ...mail,
    });
    expect(lines.join('')).toMatch(/\[DEV MAIL\][\s\S]*to: a@b\.co[\s\S]*123456/);
  });
});

describe('ConsoleEmailSender (development mailbox)', () => {
  it('keeps the [DEV MAIL] preview format with sender, recipient, subject and body', async () => {
    const lines: string[] = [];
    await new ConsoleEmailSender('TicketFlow <no-reply@x.test>', (t) => lines.push(t)).send({
      to: 'customer@example.com',
      subject: 'Your TicketFlow tickets: Rock Night',
      text: 'Booking ID: b-1\nSeats: Row A seat 1',
    });
    const output = lines.join('');
    expect(output).toContain('[DEV MAIL] from: TicketFlow <no-reply@x.test>');
    expect(output).toContain('to: customer@example.com');
    expect(output).toContain('subject: Your TicketFlow tickets: Rock Night');
    expect(output).toContain('Seats: Row A seat 1');
    expect(output.match(/-{60}/g)).toHaveLength(2);
  });
});
