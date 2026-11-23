import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisTtlStore, type TtlStore } from '../../../src/infrastructure/redis/TtlStore';
import { LoginThrottle } from '../../../src/services/auth/LoginThrottle';
import {
  PROXY_HEADERS,
  signClientIp,
  verifySignedClientIp,
} from '../../../src/shared/security/trustedProxy';

const options = {
  secret: 'unit-test-secret-0123456789abcdefghij',
  maxPerEmail: 2,
  maxPerIp: 5,
  windowSeconds: 60,
};

describe('LoginThrottle', () => {
  let redis: Redis;
  let store: TtlStore;
  beforeEach(() => {
    const prefix = `lt${Date.now()}${Math.random()}:`;
    redis = new RedisMock({ keyPrefix: prefix }) as unknown as Redis;
    store = new RedisTtlStore(redis, prefix);
  });
  afterEach(() => redis.disconnect());

  it('normalizes emails so case and whitespace variants share one counter', async () => {
    const throttle = new LoginThrottle(store, options);
    await throttle.attempt('User@Example.com', '1.1.1.1');
    await throttle.attempt('  user@example.COM ', '2.2.2.2');
    await expect(throttle.attempt('user@example.com', '3.3.3.3')).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('fails safe when Redis is down: keeps throttling in memory instead of failing open or closed', async () => {
    const broken: TtlStore = {
      ...store,
      increment: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      delete: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as TtlStore;
    const error = jest.fn();
    const throttle = new LoginThrottle(broken, {
      ...options,
      logger: { error, warn: jest.fn() } as never,
    });
    await throttle.attempt('a@example.com', '1.1.1.1'); // sign-in still possible
    await throttle.attempt('a@example.com', '1.1.1.1');
    await expect(throttle.attempt('a@example.com', '1.1.1.1')).rejects.toMatchObject({
      statusCode: 429,
    });
    await throttle.succeeded('a@example.com'); // reset works on the fallback too
    await throttle.attempt('a@example.com', '1.1.1.1');
    expect(error).toHaveBeenCalled();
  });
});

describe('trusted proxy signatures', () => {
  const secret = 'proxy-secret-0123456789abcdefghijklmn';
  const now = 1_800_000_000;
  const headers = (ip: string, ts = now, sig = signClientIp(secret, ip, ts)) => ({
    [PROXY_HEADERS.clientIp]: ip,
    [PROXY_HEADERS.timestamp]: String(ts),
    [PROXY_HEADERS.signature]: sig,
  });

  it('accepts a fresh valid signature for IPv4 and IPv6', () => {
    expect(verifySignedClientIp(headers('192.0.2.1'), secret, now)).toBe('192.0.2.1');
    expect(verifySignedClientIp(headers('2001:db8::1'), secret, now + 59)).toBe('2001:db8::1');
  });

  it('rejects wrong secrets, stale or future timestamps, tampering and junk', () => {
    expect(
      verifySignedClientIp(headers('192.0.2.1'), 'another-secret-0123456789abcdefghij', now),
    ).toBeNull();
    expect(verifySignedClientIp(headers('192.0.2.1', now - 61), secret, now)).toBeNull();
    expect(verifySignedClientIp(headers('192.0.2.1', now + 61), secret, now)).toBeNull();
    expect(
      verifySignedClientIp(
        { ...headers('192.0.2.1'), [PROXY_HEADERS.clientIp]: '192.0.2.2' },
        secret,
        now,
      ),
    ).toBeNull();
    expect(verifySignedClientIp(headers('not-an-ip'), secret, now)).toBeNull();
    expect(verifySignedClientIp(headers('192.0.2.1', now, 'zz'), secret, now)).toBeNull();
    expect(verifySignedClientIp({}, secret, now)).toBeNull();
    expect(
      verifySignedClientIp(
        { ...headers('192.0.2.1'), [PROXY_HEADERS.clientIp]: ['192.0.2.1', 'x'] },
        secret,
        now,
      ),
    ).toBeNull();
  });
});
