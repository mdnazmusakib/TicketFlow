import type { Role } from '../domain/auth/roles';
import type { Queryable } from '../infrastructure/database/types';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  emailVerified: boolean;
  isActive: boolean;
  createdAt: Date;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  email_verified: boolean;
  is_active: boolean;
  created_at: Date;
}

const COLUMNS = 'id, name, email, password_hash, role, email_verified, is_active, created_at';

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    emailVerified: row.email_verified,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  emailVerified: boolean;
}

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async findByEmail(email: string, db: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string, db: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Returns null when the email is already registered (unique index on lower(email)). */
  async create(input: CreateUserInput, db: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (name, email, password_hash, role, email_verified, email_verified_at)
       VALUES ($1, lower($2), $3, $4, $5, CASE WHEN $5 THEN now() END)
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.name, input.email, input.passwordHash, input.role, input.emailVerified],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markEmailVerified(id: string, db: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(
      `UPDATE users SET email_verified = true, email_verified_at = COALESCE(email_verified_at, now())
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async recordLogin(id: string, db: Queryable = this.db): Promise<void> {
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  }
}
