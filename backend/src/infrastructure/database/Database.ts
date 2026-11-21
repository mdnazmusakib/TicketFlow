import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import type { Queryable, TransactionOptions, TransactionRunner } from './types';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Transaction-capable PostgreSQL access. All statements of a transaction run on
 * ONE pooled connection between BEGIN and COMMIT — never across separate
 * Supabase API calls, which would not be atomic.
 */
export class Database implements Queryable, TransactionRunner {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
  ) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values as unknown[] | undefined);
  }

  async withTransaction<T>(
    work: (tx: Queryable) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runOnce(work, options);
      } catch (error) {
        if (attempt < maxRetries && isRetryableTransactionError(error)) {
          const backoffMs = 20 * 2 ** attempt + Math.floor(Math.random() * 20);
          this.logger?.warn({ attempt: attempt + 1, sqlState: sqlState(error) }, 'Retrying transaction');
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw error;
      }
    }
  }

  private async runOnce<T>(work: (tx: Queryable) => Promise<T>, options: TransactionOptions): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    let released = false;
    try {
      const mode = [
        `ISOLATION LEVEL ${options.isolationLevel ?? 'READ COMMITTED'}`,
        options.readOnly ? 'READ ONLY' : 'READ WRITE',
      ].join(' ');
      await client.query(`BEGIN ${mode}`);
      const tx: Queryable = {
        query: <R extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
          client.query<R>(text, values as unknown[] | undefined),
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Connection is in an unknown state: destroy it instead of returning it to the pool.
        this.logger?.error({ err: rollbackError }, 'ROLLBACK failed; discarding connection');
        client.release(rollbackError as Error);
        released = true;
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
