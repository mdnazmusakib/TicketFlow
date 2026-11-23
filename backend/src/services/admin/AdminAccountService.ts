import type { TransactionRunner } from '../../infrastructure/database/types';
import type { PasswordHasher } from '../../infrastructure/security/PasswordHasher';
import type { UserRecord, UserRepository } from '../../repositories/UserRepository';
import { passwordSchema } from '../../schemas/auth.schemas';
import { AppError, NotFoundError } from '../../shared/errors/AppError';

export interface AdminSummary {
  email: string;
  name: string;
  active: boolean;
  emailVerified: boolean;
}

const summary = (user: UserRecord): AdminSummary => ({
  email: user.email,
  name: user.name,
  active: user.isActive,
  emailVerified: user.emailVerified,
});

/**
 * Operator-only administration of ADMIN accounts (used by `npm run admin -w backend`;
 * deliberately not exposed over HTTP). Nothing here ever prints or returns a password.
 */
export class AdminAccountService {
  constructor(
    private readonly db: TransactionRunner,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async listAdmins(): Promise<AdminSummary[]> {
    return (await this.users.listByRole('ADMIN')).map(summary);
  }

  private async find(email: string): Promise<UserRecord> {
    const user = await this.users.findByEmail(email);
    if (!user) throw new NotFoundError('No account with this email');
    return user;
  }

  /** Grants ADMIN to an existing (self-registered) account. */
  async promote(email: string): Promise<AdminSummary> {
    const user = await this.find(email);
    await this.users.setRole(user.id, 'ADMIN');
    return summary({ ...user, role: 'ADMIN' });
  }

  /** Replaces the password (same strength rules as registration). */
  async setPassword(email: string, newPassword: string): Promise<void> {
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Password rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const user = await this.find(email);
    await this.users.setPasswordHash(user.id, await this.hasher.hash(newPassword));
  }

  /**
   * Activates/deactivates an account. Deactivation takes effect on the next request
   * (sessions are checked against is_active). The last active admin cannot be deactivated.
   */
  async setActive(email: string, active: boolean): Promise<AdminSummary> {
    return this.db.withTransaction(async (tx) => {
      const user = await this.users.findByEmail(email, tx);
      if (!user) throw new NotFoundError('No account with this email');
      if (!active && user.role === 'ADMIN') {
        const admins = await this.users.listByRole('ADMIN', tx);
        const others = admins.filter((a) => a.isActive && a.id !== user.id);
        if (others.length === 0) {
          throw new AppError(
            409,
            'CONFLICT',
            'Refusing to deactivate the last active admin; create or promote another admin first',
          );
        }
      }
      await this.users.setActive(user.id, active, tx);
      return summary({ ...user, isActive: active });
    });
  }
}
