import type { Logger } from 'pino';
import type { Actor, SelfRegistrationRole } from '../../domain/auth/roles';
import { otpEmail, type EmailSender } from '../../domain/notifications/email';
import type { PasswordHasher } from '../../infrastructure/security/PasswordHasher';
import type { UserRecord, UserRepository } from '../../repositories/UserRepository';
import { AppError, UnauthorizedError } from '../../shared/errors/AppError';
import type { LoginThrottle } from './LoginThrottle';
import type { OtpService } from './OtpService';
import type { IssuedToken, TokenClaims, TokenService } from './TokenService';

/** Public user shape. Never contains the password hash or internal flags. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRecord['role'];
  emailVerified: boolean;
  createdAt: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role: SelfRegistrationRole;
}

export interface RegisterResult {
  user: PublicUser;
  /**
   * True only when email verification is mandatory: the user must enter the OTP before
   * signing in. False when verification is optional or bypassed in tests (user is signed in).
   */
  verificationRequired: boolean;
  session?: IssuedToken;
}

export interface Session {
  user: PublicUser;
  session: IssuedToken;
}

export interface AuthServiceOptions {
  otpBypass: boolean;
  /**
   * Mandatory email verification (REQUIRE_EMAIL_VERIFICATION). When false, unverified
   * accounts can sign in and use the app; email_verified still records the real status
   * and the OTP verify/resend endpoints keep working for users who want to verify.
   */
  requireEmailVerification: boolean;
  otpTtlSeconds: number;
  /** Per-account / per-IP sign-in throttling (brute-force protection). */
  loginThrottle?: LoginThrottle;
  logger?: Logger;
}

const GENERIC_CREDENTIALS_ERROR = 'Invalid email or password';

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly email: EmailSender,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(input: RegisterInput): Promise<RegisterResult> {
    const passwordHash = await this.hasher.hash(input.password);
    const user = await this.users.create({
      name: input.name,
      email: input.email,
      passwordHash,
      role: input.role,
      emailVerified: this.options.otpBypass,
    });
    if (!user) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');

    if (this.options.otpBypass) {
      this.options.logger?.warn(
        { userId: user.id },
        'OTP bypass active: account verified without code',
      );
      return {
        user: toPublicUser(user),
        verificationRequired: false,
        session: this.tokens.issue(user),
      };
    }

    if (this.options.requireEmailVerification) {
      await this.sendOtp(user);
      return { user: toPublicUser(user), verificationRequired: true };
    }

    // Verification is optional: sign the user in now. The verification email is still sent
    // (best effort) so the address can be confirmed later; a mail outage never blocks signup.
    try {
      await this.sendOtp(user);
    } catch (error) {
      this.options.logger?.warn({ err: error, userId: user.id }, 'Verification email not sent');
    }
    await this.users.recordLogin(user.id);
    return {
      user: toPublicUser(user),
      verificationRequired: false,
      session: this.tokens.issue(user),
    };
  }

  async verifyEmail(email: string, code: string): Promise<Session> {
    const user = await this.users.findByEmail(email);
    if (!user) throw new AppError(400, 'OTP_INVALID', 'Invalid or expired verification code');
    if (user.emailVerified) {
      throw new AppError(409, 'CONFLICT', 'Email is already verified. Please sign in.');
    }

    const result = await this.otp.verify(user.email, code);
    switch (result) {
      case 'VALID':
        break;
      case 'EXPIRED':
        throw new AppError(400, 'OTP_EXPIRED', 'Verification code expired. Request a new one.');
      case 'ATTEMPTS_EXCEEDED':
        throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many attempts. Request a new code.');
      default:
        throw new AppError(400, 'OTP_INVALID', 'Invalid or expired verification code');
    }

    const verified = await this.users.markEmailVerified(user.id);
    if (!verified) throw new AppError(400, 'OTP_INVALID', 'Invalid or expired verification code');
    await this.users.recordLogin(verified.id);
    return { user: toPublicUser(verified), session: this.tokens.issue(verified) };
  }

  /**
   * Re-sends a code. Responds identically whether or not the account exists
   * (no email enumeration); cooldown errors only surface for real accounts.
   */
  async resendOtp(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerified || !user.isActive || this.options.otpBypass) return;
    await this.sendOtp(user);
  }

  async login(email: string, password: string, clientIp = 'unknown'): Promise<Session> {
    // Counted before any lookup or hash check: same cost and answer for unknown accounts.
    await this.options.loginThrottle?.attempt(email, clientIp);
    const user = await this.users.findByEmail(email);
    if (!user) {
      await this.hasher.verifyDummy(password);
      throw new AppError(401, 'INVALID_CREDENTIALS', GENERIC_CREDENTIALS_ERROR);
    }
    if (!(await this.hasher.verify(password, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', GENERIC_CREDENTIALS_ERROR);
    }
    if (!user.isActive) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    if (this.options.requireEmailVerification && !user.emailVerified) {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before signing in');
    }
    await this.options.loginThrottle?.succeeded(email);
    await this.users.recordLogin(user.id);
    return { user: toPublicUser(user), session: this.tokens.issue(user) };
  }

  async logout(claims: Pick<TokenClaims, 'jti' | 'expiresAt'>): Promise<void> {
    await this.tokens.revoke(claims);
  }

  /** Resolves a session token to an active actor; used by the authenticate middleware. */
  async authenticate(
    token: string,
  ): Promise<{ actor: Actor; user: PublicUser; claims: TokenClaims }> {
    const claims = await this.tokens.verify(token);
    const user = await this.users.findById(claims.userId);
    if (!user || !user.isActive || (this.options.requireEmailVerification && !user.emailVerified)) {
      throw new UnauthorizedError('Session is invalid or has expired');
    }
    // Role is read from the database, so role changes apply immediately.
    return { actor: { id: user.id, role: user.role }, user: toPublicUser(user), claims };
  }

  private async sendOtp(user: UserRecord): Promise<void> {
    const code = await this.otp.issue(user.email);
    const content = otpEmail({
      name: user.name,
      code,
      ttlMinutes: Math.round(this.options.otpTtlSeconds / 60),
    });
    await this.email.send({ to: user.email, ...content });
  }
}
