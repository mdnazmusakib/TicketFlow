import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { Pool, type PoolConfig } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env';

/**
 * Creates the PostgreSQL pool. Supabase is reached through a direct or
 * session-pooler connection string so real multi-statement transactions work.
 */
export function createPool(config: AppConfig['database'], logger?: Logger): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs + 1_000,
    idle_in_transaction_session_timeout: config.statementTimeoutMs * 2,
    application_name: 'ticketflow-api',
    ssl: buildSslOptions(config, logger),
  };

  const pool = new Pool(poolConfig);
  pool.on('error', (error) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    logger?.error({ err: error }, 'PostgreSQL idle client error');
  });
  return pool;
}

function buildSslOptions(
  config: AppConfig['database'],
  logger?: Logger,
): ConnectionOptions | false {
  if (!config.ssl) return false;
  if (config.sslCaPath) {
    // Full verification against the Supabase root CA.
    return { ca: readFileSync(config.sslCaPath, 'utf8'), rejectUnauthorized: true };
  }
  // Traffic is still encrypted; set DATABASE_SSL_CA_PATH to also verify the server identity.
  logger?.warn('DATABASE_SSL_CA_PATH not set: TLS enabled without certificate verification');
  return { rejectUnauthorized: false };
}
