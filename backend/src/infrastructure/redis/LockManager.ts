import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface Lock {
  readonly keys: readonly string[];
  readonly token: string;
  readonly ttlMs: number;
}

/** Abstraction used by services; Redis is one implementation (DIP). */
export interface LockManager {
  /** All-or-nothing acquisition of every key. Returns null if any key is taken. */
  acquire(keys: readonly string[], ttlMs: number): Promise<Lock | null>;
  /** Releases only keys still owned by this lock's token. Returns the count released. */
  release(lock: Lock): Promise<number>;
  /** Extends the TTL only if every key is still owned by this lock. */
  extend(lock: Lock, ttlMs: number): Promise<boolean>;
  /** Runs work while holding the lock and always releases afterwards. Null if not acquired. */
  withLock<T>(
    keys: readonly string[],
    ttlMs: number,
    work: (lock: Lock) => Promise<T>,
  ): Promise<{ acquired: true; result: T } | { acquired: false }>;
}

// KEYS = lock keys, ARGV[1] = owner token, ARGV[2] = ttl ms.
// Checks every key first, then sets all. Atomic because Redis runs scripts serially.
const ACQUIRE_SCRIPT = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    return 0
  end
end
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[1], 'PX', ARGV[2])
end
return 1
`;

// Compare-and-delete: never removes a lock that expired and was re-acquired by someone else.
const RELEASE_SCRIPT = `
local released = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    redis.call('DEL', KEYS[i])
    released = released + 1
  end
end
return released
`;

const EXTEND_SCRIPT = `
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[1] then
    return 0
  end
end
for i = 1, #KEYS do
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return 1
`;

export const MAX_KEYS_PER_LOCK = 50;

function normalize(keys: readonly string[], ttlMs: number): string[] {
  if (keys.length === 0) throw new Error('At least one lock key is required');
  if (!Number.isInteger(ttlMs) || ttlMs < 100) {
    throw new Error('Lock TTL must be an integer of at least 100ms');
  }
  // De-duplicated and sorted: stable ordering, no self-conflict on duplicate keys.
  const unique = [...new Set(keys)].sort();
  if (unique.length > MAX_KEYS_PER_LOCK) {
    throw new Error(`At most ${MAX_KEYS_PER_LOCK} keys per lock`);
  }
  return unique;
}

export class RedisLockManager implements LockManager {
  constructor(private readonly redis: Redis) {}

  async acquire(keys: readonly string[], ttlMs: number): Promise<Lock | null> {
    const uniqueKeys = normalize(keys, ttlMs);
    const token = randomUUID();
    const result = await this.redis.eval(
      ACQUIRE_SCRIPT,
      uniqueKeys.length,
      ...uniqueKeys,
      token,
      String(ttlMs),
    );
    return Number(result) === 1 ? { keys: uniqueKeys, token, ttlMs } : null;
  }

  async release(lock: Lock): Promise<number> {
    if (lock.keys.length === 0) return 0;
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      lock.keys.length,
      ...lock.keys,
      lock.token,
    );
    return Number(result);
  }

  async extend(lock: Lock, ttlMs: number): Promise<boolean> {
    normalize(lock.keys, ttlMs);
    const result = await this.redis.eval(
      EXTEND_SCRIPT,
      lock.keys.length,
      ...lock.keys,
      lock.token,
      String(ttlMs),
    );
    return Number(result) === 1;
  }

  async withLock<T>(
    keys: readonly string[],
    ttlMs: number,
    work: (lock: Lock) => Promise<T>,
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const lock = await this.acquire(keys, ttlMs);
    if (!lock) return { acquired: false };
    try {
      return { acquired: true, result: await work(lock) };
    } finally {
      await this.release(lock);
    }
  }
}
