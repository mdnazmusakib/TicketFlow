import type Redis from 'ioredis';

/** Small key/value-with-expiry abstraction (OTP storage, counters, caches). */
export interface TtlStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Stores only if absent. Returns true when the value was stored. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Atomically reads and deletes (single-use values such as OTPs). */
  take(key: string): Promise<string | null>;
  /** Deletes the key only if it currently holds `expected`. True when deleted (single winner). */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  delete(...keys: string[]): Promise<number>;
  /** Remaining TTL in seconds: -2 when missing, -1 when the key has no expiry. */
  ttl(key: string): Promise<number>;
  /** Increments a counter; the TTL is applied when the counter is created. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Deletes keys matching a pattern with non-blocking SCAN + UNLINK batches. */
  deleteByPattern(pattern: string, batchSize?: number): Promise<number>;
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('TTL must be a positive integer number of seconds');
  }
}

const TAKE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

const COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const INCREMENT_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

export class RedisTtlStore implements TtlStore {
  constructor(
    private readonly redis: Redis,
    /** Must equal the client's keyPrefix: ioredis does not prefix SCAN patterns. */
    private readonly keyPrefix: string,
  ) {}

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    assertTtl(ttlSeconds);
    const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async take(key: string): Promise<string | null> {
    const result = await this.redis.eval(TAKE_SCRIPT, 1, key);
    return typeof result === 'string' ? result : null;
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    return Number(await this.redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, expected)) === 1;
  }

  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    assertTtl(ttlSeconds);
    return Number(await this.redis.eval(INCREMENT_SCRIPT, 1, key, String(ttlSeconds)));
  }

  async deleteByPattern(pattern: string, batchSize = 200): Promise<number> {
    if (pattern.trim() === '' || /^\*+$/.test(pattern)) {
      throw new Error('Refusing to delete with an empty or match-all pattern');
    }
    // Phase 1: collect matches with incremental SCAN (never blocking KEYS).
    // Deleting only after the scan completes keeps the cursor stable.
    const matches = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.keyPrefix}${pattern}`,
        'COUNT',
        batchSize,
      );
      cursor = nextCursor;
      for (const key of rawKeys) {
        // SCAN returns fully-prefixed keys; strip the prefix because ioredis re-applies it.
        matches.add(key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) : key);
      }
    } while (cursor !== '0');

    // Phase 2: non-blocking UNLINK in bounded batches.
    const keys = [...matches];
    let deleted = 0;
    for (let i = 0; i < keys.length; i += batchSize) {
      deleted += await this.redis.unlink(...keys.slice(i, i + batchSize));
    }
    return deleted;
  }
}
