import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type { TtlStore } from '../../infrastructure/redis/TtlStore';
import { RedisKeys } from '../../infrastructure/redis/keys';
import { AppError } from '../../shared/errors/AppError';

export interface LoginThrottleOptions {
  /** Key for hashing emails/IPs into Redis keys (no raw emails in Redis). */
  secret: string;
  maxPerEmail: number;
  maxPerIp: number;
  windowSeconds: number;
  logger?: Logger;
}

/** Bounded per-process fallback used only while Redis is unreachable. */
class MemoryCounters {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  increment(key: string, ttlSeconds: number): number {
    const now = Date.now();
    const current = this.counters.get(key);
    if (!current || current.expiresAt <= now) {
      if (this.counters.size >= 10_000) this.evict(now);
      this.counters.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }

  delete(key: string): void {
    this.counters.delete(key);
  }

  private evict(now: number): void {
    for (const [key, value] of this.counters) {
      if (value.expiresAt <= now) this.counters.delete(key);
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const key of this.counters.keys()) {
      if (this.counters.size < 10_000) break;
      this.counters.delete(key);
    }
  }
}

export const TOO_MANY_LOGIN_ATTEMPTS =
  'Too many sign-in attempts. Please wait a few minutes and try again.';

/**
 * Brute-force protection for sign-in, independent of the HTTP rate limiter:
 * - per account: attempts for one (normalized) email, from any IP, are capped, so
 *   rotating IP addresses does not help an attacker;
 * - per client IP: attempts against many accounts from one trusted IP are capped.
 *
 * Counters are fixed windows in Redis (atomic INCR + EXPIRE in one Lua script), counted
 * BEFORE the password is checked so concurrent requests cannot race past the limit. The
 * account counter is cleared after a successful sign-in; nothing is locked permanently
 * (an attacker can delay a victim's sign-in by at most one window, never block it for
 * good). Unknown emails are counted exactly like real ones (no account enumeration).
 * Keys hold an HMAC of the email/IP, never the raw value.
 *
 * Redis outage policy: fail safe, not open. Counting continues in a bounded in-memory
 * store on this instance, so sign-in keeps working and stays throttled per instance.
 */
export class LoginThrottle {
  private readonly fallback = new MemoryCounters();

  constructor(
    private readonly store: TtlStore,
    private readonly options: LoginThrottleOptions,
  ) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private digest(kind: 'email' | 'ip', value: string): string {
    return createHmac('sha256', this.options.secret)
      .update(`login-throttle:${kind}:${value}`)
      .digest('hex')
      .slice(0, 40);
  }

  private async increment(key: string): Promise<number> {
    try {
      return await this.store.increment(key, this.options.windowSeconds);
    } catch (error) {
      this.options.logger?.error(
        { err: error },
        'Login throttle: Redis unavailable, using in-memory counters',
      );
      return this.fallback.increment(key, this.options.windowSeconds);
    }
  }

  /** Records one sign-in attempt; throws 429 when the account or IP is over its limit. */
  async attempt(email: string, clientIp: string): Promise<void> {
    const emailKey = RedisKeys.loginAttemptsEmail(
      this.digest('email', LoginThrottle.normalizeEmail(email)),
    );
    const ipKey = RedisKeys.loginAttemptsIp(this.digest('ip', clientIp));
    const [perEmail, perIp] = await Promise.all([this.increment(emailKey), this.increment(ipKey)]);
    if (perEmail > this.options.maxPerEmail || perIp > this.options.maxPerIp) {
      throw new AppError(429, 'RATE_LIMITED', TOO_MANY_LOGIN_ATTEMPTS);
    }
  }

  /** Clears the account counter after a successful sign-in (the IP counter keeps decaying). */
  async succeeded(email: string): Promise<void> {
    const key = RedisKeys.loginAttemptsEmail(
      this.digest('email', LoginThrottle.normalizeEmail(email)),
    );
    this.fallback.delete(key);
    try {
      await this.store.delete(key);
    } catch (error) {
      this.options.logger?.warn({ err: error }, 'Login throttle: could not reset counter');
    }
  }
}
