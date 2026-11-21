import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { HealthController } from './controllers/HealthController';
import { Database } from './infrastructure/database/Database';
import { createPool } from './infrastructure/database/pool';
import { createRedisClient } from './infrastructure/redis/client';
import { RedisLockManager, type LockManager } from './infrastructure/redis/LockManager';
import { RedisTtlStore, type TtlStore } from './infrastructure/redis/TtlStore';
import { PostgresHealthProbe, RedisHealthProbe } from './repositories/HealthProbes';
import { HealthService } from './services/HealthService';
import { APP_VERSION } from './version';

export interface Controllers {
  health: HealthController;
}

export interface Infrastructure {
  db: Database;
  redis: Redis;
  lockManager: LockManager;
  ttlStore: TtlStore;
}

export interface Container {
  infrastructure: Infrastructure;
  controllers: Controllers;
  /** Connects to Redis and verifies PostgreSQL. Fails fast on startup. */
  start(): Promise<void>;
  /** Closes every connection; safe to call more than once. */
  close(): Promise<void>;
}

/** Composition root: the only place concrete implementations are wired together. */
export function buildContainer(config: AppConfig, logger: Logger): Container {
  const db = new Database(createPool(config.database, logger), logger);
  const redis = createRedisClient(config.redis, logger);
  const infrastructure: Infrastructure = {
    db,
    redis,
    lockManager: new RedisLockManager(redis),
    ttlStore: new RedisTtlStore(redis, config.redis.keyPrefix),
  };

  const healthService = new HealthService([new PostgresHealthProbe(db), new RedisHealthProbe(redis)], {
    timeoutMs: 3_000,
    version: APP_VERSION,
    startedAt: new Date(),
  });

  let closed = false;

  return {
    infrastructure,
    controllers: { health: new HealthController(healthService) },
    async start() {
      await redis.connect();
      await db.ping();
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([db.close(), redis.quit()]);
    },
  };
}
