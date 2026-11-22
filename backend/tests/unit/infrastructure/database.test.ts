import type { Pool } from 'pg';
import {
  Database,
  isRetryableTransactionError,
} from '../../../src/infrastructure/database/Database';
import { mapPgError } from '../../../src/infrastructure/database/pgErrors';
import { ConflictError, ValidationError } from '../../../src/shared/errors/AppError';

type Script = (sql: string) => unknown;

function fakePool(script: Script) {
  const statements: string[] = [];
  const release = jest.fn();
  const client = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql);
      const outcome = script(sql);
      if (outcome instanceof Error) throw outcome;
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [{ '?column?': 1 }] })),
    end: jest.fn(async () => undefined),
  };
  return { pool: pool as unknown as Pool, statements, release, poolMock: pool };
}

const pgError = (code: string) => Object.assign(new Error(code), { code });

describe('Database.withTransaction', () => {
  it('runs BEGIN/COMMIT on a single connection and releases it', async () => {
    const { pool, statements, release } = fakePool(() => undefined);
    const db = new Database(pool);
    const result = await db.withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(statements).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
      'SELECT 1',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledWith();
  });

  it('honours isolation level and read-only options', async () => {
    const { pool, statements } = fakePool(() => undefined);
    await new Database(pool).withTransaction(async () => undefined, {
      isolationLevel: 'SERIALIZABLE',
      readOnly: true,
    });
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  });

  it('rolls back and rethrows when work fails', async () => {
    const { pool, statements, release } = fakePool(() => undefined);
    await expect(
      new Database(pool).withTransaction(async () => {
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE', 'ROLLBACK']);
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys the connection if ROLLBACK itself fails', async () => {
    const rollbackFailure = new Error('connection lost');
    const { pool, release } = fakePool((sql) => (sql === 'ROLLBACK' ? rollbackFailure : undefined));
    await expect(
      new Database(pool).withTransaction(async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(rollbackFailure);
  });

  it('retries serialization failures and deadlocks, then succeeds', async () => {
    const { pool } = fakePool(() => undefined);
    const db = new Database(pool);
    let calls = 0;
    const result = await db.withTransaction(async () => {
      calls += 1;
      if (calls === 1) throw pgError('40001');
      if (calls === 2) throw pgError('40P01');
      return calls;
    });
    expect(result).toBe(3);
  });

  it('gives up after maxRetries and does not retry other errors', async () => {
    const { pool } = fakePool(() => undefined);
    const db = new Database(pool);
    let calls = 0;
    await expect(
      db.withTransaction(
        async () => {
          calls += 1;
          throw pgError('40001');
        },
        { maxRetries: 1 },
      ),
    ).rejects.toThrow('40001');
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      db.withTransaction(async () => {
        calls += 1;
        throw pgError('23505');
      }),
    ).rejects.toThrow('23505');
    expect(calls).toBe(1);
  });

  it('ping and close delegate to the pool', async () => {
    const { pool, poolMock } = fakePool(() => undefined);
    const db = new Database(pool);
    await db.ping();
    await db.query('SELECT 2', [1]);
    await db.close();
    expect(poolMock.query).toHaveBeenCalledWith('SELECT 1');
    expect(poolMock.query).toHaveBeenCalledWith('SELECT 2', [1]);
    expect(poolMock.end).toHaveBeenCalled();
  });
});

describe('isRetryableTransactionError', () => {
  it('detects only serialization/deadlock SQLSTATEs', () => {
    expect(isRetryableTransactionError(pgError('40001'))).toBe(true);
    expect(isRetryableTransactionError(pgError('40P01'))).toBe(true);
    expect(isRetryableTransactionError(pgError('23505'))).toBe(false);
    expect(isRetryableTransactionError(new Error('x'))).toBe(false);
    expect(isRetryableTransactionError({ code: 1 })).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });
});

describe('mapPgError', () => {
  const withConstraint = (code: string, constraint?: string) =>
    Object.assign(new Error('raw'), { code, ...(constraint ? { constraint } : {}) });

  it('maps integrity violations to safe client errors', () => {
    expect(mapPgError(withConstraint('23505', 'uq_users_email_lower'))).toBeInstanceOf(
      ConflictError,
    );
    expect(mapPgError(withConstraint('23503', 'fk'))).toBeInstanceOf(ConflictError);
    expect(mapPgError(withConstraint('23001', 'fk'))).toBeInstanceOf(ConflictError);
    expect(mapPgError(withConstraint('23P01'))).toBeInstanceOf(ConflictError);
    expect(mapPgError(withConstraint('23514', 'chk_bookings_amounts'))).toBeInstanceOf(
      ValidationError,
    );
    expect(mapPgError(withConstraint('23502'))).toBeInstanceOf(ValidationError);
    expect(mapPgError(withConstraint('22P02'))).toBeInstanceOf(ValidationError);
    expect(mapPgError(withConstraint('23505'))?.message).toContain('unknown');
  });

  it('ignores non-database errors and unmapped codes', () => {
    expect(mapPgError(new Error('x'))).toBeUndefined();
    expect(mapPgError(withConstraint('ECONNREFUSED'))).toBeUndefined();
    expect(mapPgError(withConstraint('57014'))).toBeUndefined();
    expect(mapPgError('string')).toBeUndefined();
  });
});
