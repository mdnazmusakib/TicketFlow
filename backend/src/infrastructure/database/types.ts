import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal query surface shared by the pool and a transaction client.
 * Repositories depend on this abstraction (DIP), so the same repository code
 * runs inside or outside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  /** Extra attempts on serialization failure / deadlock (default 2). */
  maxRetries?: number;
}

export interface TransactionRunner {
  withTransaction<T>(work: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
}
