import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { RedisKeys } from '../../infrastructure/redis/keys';
import type { TtlStore } from '../../infrastructure/redis/TtlStore';
import { AppError } from '../../shared/errors/AppError';

export interface OtpOptions {
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  /** HMAC key: OTPs are stored hashed, never in plain text. */
  secret: string;
}

export type OtpVerification = 'VALID' | 'INVALID' | 'EXPIRED' | 'ATTEMPTS_EXCEEDED';

/**
 * Email OTP lifecycle on Redis:
 * - 6-digit code from a CSPRNG, stored as HMAC-SHA256 with a 300 s TTL;
 * - issuing a new code replaces the old one and resets attempts;
 * - resend cooldown per email;
 * - attempt counter shares the code's lifetime; exceeding it burns the code;
 * - successful verification deletes the code atomically (single use / replay-safe).
 */
export class OtpService {
  constructor(
    private readonly store: TtlStore,
    private readonly options: OtpOptions,
  ) {}

  /** Issues a new code. Throws OTP_COOLDOWN when called again too soon. */
  async issue(email: string): Promise<string> {
    const allowed = await this.store.setIfAbsent(
      RedisKeys.otpCooldown(email),
      '1',
      this.options.resendCooldownSeconds,
    );
    if (!allowed) {
      const wait = Math.max(1, await this.store.ttl(RedisKeys.otpCooldown(email)));
      throw new AppError(
        429,
        'OTP_COOLDOWN',
        `Please wait ${wait} seconds before requesting a new code`,
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.store.delete(RedisKeys.otpAttempts(email));
    await this.store.set(RedisKeys.otp(email), this.hash(email, code), this.options.ttlSeconds);
    return code;
  }

  async verify(email: string, code: string): Promise<OtpVerification> {
    const key = RedisKeys.otp(email);
    const stored = await this.store.get(key);
    if (!stored) return 'EXPIRED';

    const attempts = await this.store.increment(
      RedisKeys.otpAttempts(email),
      this.options.ttlSeconds,
    );
    if (attempts > this.options.maxAttempts) {
      await this.store.delete(key, RedisKeys.otpAttempts(email));
      return 'ATTEMPTS_EXCEEDED';
    }

    const candidate = this.hash(email, code);
    if (!this.equal(candidate, stored)) return 'INVALID';

    // Atomic consume: of two concurrent correct submissions only one wins.
    const consumed = await this.store.compareAndDelete(key, stored);
    if (!consumed) return 'EXPIRED';
    await this.store.delete(RedisKeys.otpAttempts(email));
    return 'VALID';
  }

  private hash(email: string, code: string): string {
    return createHmac('sha256', this.options.secret)
      .update(`${email.toLowerCase()}:${code}`)
      .digest('hex');
  }

  private equal(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
