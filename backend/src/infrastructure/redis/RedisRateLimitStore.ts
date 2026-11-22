import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import type Redis from 'ioredis';

// Fixed window: first hit creates the counter with the window TTL; returns [hits, ttl ms].
const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * express-rate-limit store backed by Redis, so limits hold across several API
 * instances (a memory store would give every instance its own budget).
 */
export class RedisRateLimitStore implements Store {
  private windowMs = 60_000;
  readonly localKeys = false;

  constructor(
    private readonly redis: Redis,
    readonly prefix: string,
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(clientKey: string): string {
    return `ratelimit:${this.prefix}:${clientKey}`;
  }

  async increment(clientKey: string): Promise<ClientRateLimitInfo> {
    const [hits, ttl] = (await this.redis.eval(
      HIT_SCRIPT,
      1,
      this.key(clientKey),
      String(this.windowMs),
    )) as [number, number];
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
  }

  async decrement(clientKey: string): Promise<void> {
    await this.redis.decr(this.key(clientKey));
  }

  async resetKey(clientKey: string): Promise<void> {
    await this.redis.del(this.key(clientKey));
  }
}
