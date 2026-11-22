import type { Queryable } from '../infrastructure/database/types';

export interface IdempotencyRecord {
  id: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  responseStatus: number | null;
  responseBody: unknown;
  lockedUntil: Date;
  lockExpired: boolean;
}

interface Row {
  id: string;
  request_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_body: unknown;
  locked_until: Date;
  lock_expired: boolean;
}

const toRecord = (row: Row): IdempotencyRecord => ({
  id: row.id,
  requestHash: row.request_hash,
  status: row.status,
  responseStatus: row.response_status,
  responseBody: row.response_body,
  lockedUntil: row.locked_until,
  lockExpired: row.lock_expired,
});

/** Persistence for `Idempotency-Key + user + endpoint` records (DATABASE_DESIGN §4.14). */
export class IdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  /** Inserts an IN_PROGRESS record; null when the scope/key already exists. */
  async tryInsert(scope: {
    userId: string;
    endpoint: string;
    key: string;
    requestHash: string;
    lockSeconds: number;
    retentionHours: number;
  }): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO idempotency_keys (user_id, endpoint, idempotency_key, request_hash, locked_until, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + make_interval(hours => $6))
       ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        scope.userId,
        scope.endpoint,
        scope.key,
        scope.requestHash,
        scope.lockSeconds,
        scope.retentionHours,
      ],
    );
    return rows[0]?.id ?? null;
  }

  async find(userId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT id, request_hash, status, response_status, response_body, locked_until,
              locked_until <= now() AS lock_expired
       FROM idempotency_keys WHERE user_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [userId, endpoint, key],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Takes over an abandoned IN_PROGRESS record (its owner crashed). True if this caller won. */
  async takeOver(id: string, lockSeconds: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => $2)
       WHERE id = $1 AND status = 'IN_PROGRESS' AND locked_until <= now()`,
      [id, lockSeconds],
    );
    return (rowCount ?? 0) > 0;
  }

  async complete(id: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys SET status = 'COMPLETED', response_status = $2, response_body = $3::jsonb
       WHERE id = $1`,
      [id, responseStatus, JSON.stringify(responseBody)],
    );
  }

  /** Lets the client retry after a failure that produced no stored response. */
  async release(id: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE id = $1 AND status = 'IN_PROGRESS'`, [
      id,
    ]);
  }

  async purgeExpired(): Promise<number> {
    const { rowCount } = await this.db.query(
      'DELETE FROM idempotency_keys WHERE expires_at <= now()',
    );
    return rowCount ?? 0;
  }
}
