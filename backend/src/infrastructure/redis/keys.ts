/**
 * Central Redis key builders (keys are additionally namespaced by REDIS_KEY_PREFIX).
 * Keeping them here prevents typos and documents every key family in one place.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_.@+-]{1,200}$/;

function segment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error('Invalid Redis key segment');
  }
  return value;
}

export const RedisKeys = {
  /** Short-lived seat lock coordinating concurrent hold attempts. */
  seatHold: (eventId: string, seatId: string): string =>
    `seat_hold:${segment(eventId)}:${segment(seatId)}`,
  /** Pattern matching every seat lock of an event (cleanup utilities). */
  seatHoldPattern: (eventId: string): string => `seat_hold:${segment(eventId)}:*`,
  /** Email OTP (stored hashed), TTL 300s. */
  otp: (email: string): string => `otp:${segment(email.toLowerCase())}`,
  /** Resend cooldown marker (prevents OTP flooding). */
  otpCooldown: (email: string): string => `otp_cooldown:${segment(email.toLowerCase())}`,
  /** Revoked JWT id (logout), kept until the token would have expired. */
  revokedToken: (jti: string): string => `revoked_jwt:${segment(jti)}`,
  /** OTP verification attempt counter. */
  otpAttempts: (email: string): string => `otp_attempts:${segment(email.toLowerCase())}`,
  /** Sign-in attempts per account (HMAC of the normalized email, never the raw address). */
  loginAttemptsEmail: (digest: string): string => `login_attempts:email:${segment(digest)}`,
  /** Sign-in attempts per trusted client IP (HMAC of the IP). */
  loginAttemptsIp: (digest: string): string => `login_attempts:ip:${segment(digest)}`,
} as const;
