import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { createRedisClient } from '../../src/infrastructure/redis/client';
import { RedisLockManager } from '../../src/infrastructure/redis/LockManager';
import { RedisTtlStore } from '../../src/infrastructure/redis/TtlStore';
import { RedisHealthProbe } from '../../src/repositories/HealthProbes';

/**
 * Live Redis connectivity against the configured server (npm run test:live).
 * Keys use a unique prefix and are removed afterwards.
 */
const url = process.env.TEST_REDIS_URL;
if (!url) throw new Error('TEST_REDIS_URL is required (run via npm run test:live)');

describe('Redis (live server)', () => {
  const keyPrefix = `tftest${randomUUID().slice(0, 8)}:`;
  let redis: Redis;

  beforeAll(async () => {
    redis = createRedisClient({ url: url!, keyPrefix });
    await redis.connect();
  });

  afterAll(async () => {
    const store = new RedisTtlStore(redis, keyPrefix);
    await store.deleteByPattern('seat_hold:*');
    await store.delete('otp:live@example.com', 'short');
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
