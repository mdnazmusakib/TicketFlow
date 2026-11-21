import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { createRedisClient } from '../../../src/infrastructure/redis/client';
import { RedisLockManager } from '../../../src/infrastructure/redis/LockManager';
import { RedisTtlStore } from '../../../src/infrastructure/redis/TtlStore';
import { RedisHealthProbe } from '../../../src/repositories/HealthProbes';

/**
 * Live Redis connectivity. Runs only when TEST_REDIS_URL is set (e.g. a local
 * Redis, Upstash, or a CI service); otherwise skipped with a visible notice.
 * Keys use a unique prefix and are removed afterwards.
 */
const url = process.env.TEST_REDIS_URL;
const describeLive = url ? describe : describe.skip;

if (!url) {
  // eslint-disable-next-line no-console
  console.info('[redisLive] TEST_REDIS_URL not set: live Redis tests skipped');
}

describeLive('Redis (live server)', () => {
  const keyPrefix = `tftest${randomUUID().slice(0, 8)}:`;
  let redis: Redis;

  beforeAll(async () => {
    redis = createRedisClient({ url: url!, keyPrefix });
    await redis.connect();
  });

  afterAll(async () => {
    await new RedisTtlStore(redis, keyPrefix).deleteByPattern('*:*').catch(() => undefined);
    await redis.quit();
  });

  it('answers PING through the health probe', async () => {
    await expect(new RedisHealthProbe(redis).check()).resolves.toBeUndefined();
  });

  it('acquires, contends, extends and releases locks atomically', async () => {
    const locks = new RedisLockManager(redis);
    const keys = ['seat_hold:e:1', 'seat_hold:e:2'];
    const lock = await locks.acquire(keys, 5_000);
    expect(lock).not.toBeNull();
    expect(await locks.acquire(['seat_hold:e:2', 'seat_hold:e:3'], 5_000)).toBeNull();
    expect(await redis.exists('seat_hold:e:3')).toBe(0);
    expect(await locks.extend(lock!, 10_000)).toBe(true);
    expect(await locks.release(lock!)).toBe(2);
  });

  it('expires keys by TTL and supports single-use reads', async () => {
    const store = new RedisTtlStore(redis, keyPrefix);
    await store.set('otp:live@example.com', 'hash', 1);
    expect(await store.take('otp:live@example.com')).toBe('hash');
    expect(await store.take('otp:live@example.com')).toBeNull();
    await new RedisLockManager(redis).acquire(['short'], 150);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await redis.exists('short')).toBe(0);
  });
});
