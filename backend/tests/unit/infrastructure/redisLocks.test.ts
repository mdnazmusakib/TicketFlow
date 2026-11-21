import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisLockManager, MAX_KEYS_PER_LOCK } from '../../../src/infrastructure/redis/LockManager';
import { RedisTtlStore } from '../../../src/infrastructure/redis/TtlStore';
import { RedisKeys } from '../../../src/infrastructure/redis/keys';

const PREFIX = 'tftest:';

function newRedis(): Redis {
  return new RedisMock({ keyPrefix: PREFIX }) as unknown as Redis;
}

describe('RedisLockManager', () => {
  let redis: Redis;
  let locks: RedisLockManager;

  beforeEach(async () => {
    redis = newRedis();
    await redis.flushall();
    locks = new RedisLockManager(redis);
  });

  afterEach(() => redis.disconnect());

  it('acquires all keys atomically with a TTL and an owner token', async () => {
    const lock = await locks.acquire(['seat:b', 'seat:a'], 5_000);
    expect(lock).not.toBeNull();
    expect(lock!.keys).toEqual(['seat:a', 'seat:b']);
    expect(await redis.get('seat:a')).toBe(lock!.token);
    const ttl = await redis.pttl('seat:b');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it('is all-or-nothing: fails without touching free keys when any key is taken', async () => {
    const first = await locks.acquire(['seat:2'], 5_000);
    expect(first).not.toBeNull();
    const second = await locks.acquire(['seat:1', 'seat:2', 'seat:3'], 5_000);
    expect(second).toBeNull();
    expect(await redis.exists('seat:1')).toBe(0);
    expect(await redis.exists('seat:3')).toBe(0);
  });

  it('lets exactly one of many concurrent contenders win', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => locks.acquire(['seat:hot'], 5_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('release only deletes keys still owned by the token (compare-and-delete)', async () => {
    const lock = (await locks.acquire(['seat:x', 'seat:y'], 5_000))!;
    // Simulate expiry of seat:y and re-acquisition by someone else.
    await redis.del('seat:y');
    const other = (await locks.acquire(['seat:y'], 5_000))!;

    expect(await locks.release(lock)).toBe(1);
    expect(await redis.exists('seat:x')).toBe(0);
    expect(await redis.get('seat:y')).toBe(other.token);
  });

  it('extend succeeds only while every key is owned', async () => {
    const lock = (await locks.acquire(['seat:e1', 'seat:e2'], 1_000))!;
    expect(await locks.extend(lock, 60_000)).toBe(true);
    expect(await redis.pttl('seat:e1')).toBeGreaterThan(1_000);

    await redis.set('seat:e2', 'someone-else');
    expect(await locks.extend(lock, 60_000)).toBe(false);
  });

  it('withLock runs work, releases afterwards, and reports contention', async () => {
    const outcome = await locks.withLock(['seat:w'], 5_000, async () => {
      expect(await redis.exists('seat:w')).toBe(1);
      const nested = await locks.withLock(['seat:w'], 5_000, async () => 'never');
      expect(nested).toEqual({ acquired: false });
      return 42;
    });
    expect(outcome).toEqual({ acquired: true, result: 42 });
    expect(await redis.exists('seat:w')).toBe(0);
  });

  it('withLock releases even when work throws', async () => {
    await expect(
      locks.withLock(['seat:t'], 5_000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await redis.exists('seat:t')).toBe(0);
  });

  it('de-duplicates keys and validates input', async () => {
    const lock = await locks.acquire(['k', 'k'], 1_000);
    expect(lock!.keys).toEqual(['k']);
    await expect(locks.acquire([], 1_000)).rejects.toThrow('At least one lock key');
    await expect(locks.acquire(['a'], 50)).rejects.toThrow('TTL');
    await expect(locks.acquire(['a'], 1.5)).rejects.toThrow('TTL');
    const tooMany = Array.from({ length: MAX_KEYS_PER_LOCK + 1 }, (_, i) => `k${i}`);
    await expect(locks.acquire(tooMany, 1_000)).rejects.toThrow('At most');
  });

  it('release of an empty lock is a no-op', async () => {
    expect(await locks.release({ keys: [], token: 't', ttlMs: 1_000 })).toBe(0);
  });
});

describe('RedisTtlStore', () => {
  let redis: Redis;
  let store: RedisTtlStore;

  beforeEach(async () => {
    redis = newRedis();
    await redis.flushall();
    store = new RedisTtlStore(redis, PREFIX);
  });

  afterEach(() => redis.disconnect());

  it('sets values with a TTL', async () => {
    await store.set('otp:a', 'hash', 300);
    expect(await store.get('otp:a')).toBe('hash');
    const ttl = await store.ttl('otp:a');
    expect(ttl).toBeGreaterThan(290);
    expect(await store.ttl('missing')).toBe(-2);
  });

  it('setIfAbsent stores only once', async () => {
    expect(await store.setIfAbsent('k', '1', 60)).toBe(true);
    expect(await store.setIfAbsent('k', '2', 60)).toBe(false);
    expect(await store.get('k')).toBe('1');
  });

  it('take reads and deletes atomically (single use)', async () => {
    await store.set('otp:b', 'v', 60);
    expect(await store.take('otp:b')).toBe('v');
    expect(await store.take('otp:b')).toBeNull();
  });

  it('increment creates the counter with a TTL and keeps counting', async () => {
    expect(await store.increment('attempts', 120)).toBe(1);
    expect(await store.increment('attempts', 120)).toBe(2);
    expect(await store.ttl('attempts')).toBeGreaterThan(0);
  });

  it('delete removes keys and tolerates empty input', async () => {
    await store.set('d1', 'x', 60);
    expect(await store.delete('d1', 'd2')).toBe(1);
    expect(await store.delete()).toBe(0);
  });

  it('deleteByPattern removes only matching keys and handles the key prefix', async () => {
    const eventId = 'evt-1';
    for (let i = 0; i < 25; i += 1) await store.set(RedisKeys.seatHold(eventId, `s${i}`), 't', 60);
    await store.set(RedisKeys.seatHold('evt-2', 's1'), 't', 60);

    expect(await store.deleteByPattern(RedisKeys.seatHoldPattern(eventId), 10)).toBe(25);
    expect(await store.get(RedisKeys.seatHold('evt-2', 's1'))).toBe('t');
  });

  it('rejects dangerous patterns and invalid TTLs', async () => {
    await expect(store.deleteByPattern('*')).rejects.toThrow('match-all');
    await expect(store.deleteByPattern('  ')).rejects.toThrow('match-all');
    await expect(store.set('k', 'v', 0)).rejects.toThrow('TTL');
    await expect(store.setIfAbsent('k', 'v', -1)).rejects.toThrow('TTL');
    await expect(store.increment('k', 1.5)).rejects.toThrow('TTL');
  });
});

describe('RedisKeys', () => {
  it('builds namespaced keys', () => {
    expect(RedisKeys.seatHold('e1', 's1')).toBe('seat_hold:e1:s1');
    expect(RedisKeys.seatHoldPattern('e1')).toBe('seat_hold:e1:*');
    expect(RedisKeys.otp('User@Example.com')).toBe('otp:user@example.com');
    expect(RedisKeys.otpAttempts('a@b.co')).toBe('otp_attempts:a@b.co');
  });

  it('rejects unsafe segments (no key injection via * or spaces)', () => {
    expect(() => RedisKeys.seatHold('e*', 's')).toThrow('Invalid Redis key segment');
    expect(() => RedisKeys.otp('a b@c.d')).toThrow('Invalid Redis key segment');
    expect(() => RedisKeys.seatHold('', 's')).toThrow('Invalid Redis key segment');
  });
});
