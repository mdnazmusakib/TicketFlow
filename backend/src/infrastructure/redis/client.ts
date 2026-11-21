import Redis, { type RedisOptions } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env';

/**
 * Creates the shared Redis client. `lazyConnect` lets the app decide when to
 * connect (and fail fast at startup); `keyPrefix` namespaces every key.
 */
export function createRedisClient(
  config: AppConfig['redis'],
  logger?: Logger,
  overrides: RedisOptions = {},
): Redis {
  const client = new Redis(config.url, {
    keyPrefix: config.keyPrefix,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...overrides,
  });

  client.on('error', (error) => logger?.error({ err: error }, 'Redis client error'));
  client.on('reconnecting', () => logger?.warn('Redis reconnecting'));
  return client;
}
