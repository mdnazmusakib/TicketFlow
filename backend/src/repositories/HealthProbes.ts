import type Redis from 'ioredis';
import type { Queryable } from '../infrastructure/database/types';

/** A dependency the API needs to serve traffic. */
export interface HealthProbe {
  readonly name: string;
  /** Resolves with optional diagnostic info, rejects when unhealthy. */
  check(): Promise<Record<string, unknown> | void>;
}

/** Verifies PostgreSQL is reachable and reports the applied schema version. */
export class PostgresHealthProbe implements HealthProbe {
  readonly name = 'database';

  constructor(private readonly db: Queryable) {}

  async check(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<{ migrated: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS migrated`,
    );
    if (!rows[0]?.migrated) return { schemaVersion: null };
    const version = await this.db.query<{ version: string | null }>(
      'SELECT max(version) AS version FROM public.schema_migrations',
    );
    return { schemaVersion: version.rows[0]?.version ?? null };
  }
}

/** Verifies Redis answers PING. */
export class RedisHealthProbe implements HealthProbe {
  readonly name = 'redis';

  constructor(private readonly redis: Pick<Redis, 'ping'>) {}

  async check(): Promise<void> {
    const reply = await this.redis.ping();
    if (reply !== 'PONG') throw new Error('Unexpected PING reply');
  }
}
