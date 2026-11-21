import type { RequestHandler } from 'express';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { AuthController } from './controllers/AuthController';
import {
  OrganizerEventController,
  PublicEventController,
  VenueController,
} from './controllers/EventController';
import { HealthController } from './controllers/HealthController';
import type { EmailSender } from './domain/notifications/email';
import { Database } from './infrastructure/database/Database';
import { createPool } from './infrastructure/database/pool';
import { ConsoleEmailSender } from './infrastructure/email/ConsoleEmailSender';
import { SmtpEmailSender } from './infrastructure/email/SmtpEmailSender';
import { createRedisClient } from './infrastructure/redis/client';
import { RedisLockManager, type LockManager } from './infrastructure/redis/LockManager';
import { RedisTtlStore, type TtlStore } from './infrastructure/redis/TtlStore';
import { BcryptPasswordHasher } from './infrastructure/security/PasswordHasher';
import { createAuthenticate } from './middlewares/auth';
import { EventRepository } from './repositories/EventRepository';
import { PostgresHealthProbe, RedisHealthProbe } from './repositories/HealthProbes';
import { SeatMapRepository } from './repositories/SeatMapRepository';
import { UserRepository } from './repositories/UserRepository';
import { VenueRepository } from './repositories/VenueRepository';
import { AuthService } from './services/auth/AuthService';
import { OtpService } from './services/auth/OtpService';
import { TokenService } from './services/auth/TokenService';
import { EventDiscoveryService } from './services/events/EventDiscoveryService';
import { EventService } from './services/events/EventService';
import { VenueService } from './services/events/VenueService';
import { HealthService } from './services/HealthService';
import { APP_VERSION } from './version';

export interface Controllers {
  health: HealthController;
  auth: AuthController;
  venues: VenueController;
  organizerEvents: OrganizerEventController;
  publicEvents: PublicEventController;
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
  authenticate: RequestHandler;
  /** Connects to Redis and verifies PostgreSQL. Fails fast on startup. */
  start(): Promise<void>;
  /** Closes every connection; safe to call more than once. */
  close(): Promise<void>;
}

/** Test seams: swap infrastructure without touching wiring. */
export interface ContainerOverrides {
  db?: Database;
  redis?: Redis;
  emailSender?: EmailSender;
  otpBypass?: boolean;
}

function createEmailSender(config: AppConfig): EmailSender {
  if (config.email.transport === 'smtp' && config.email.smtp) {
    return new SmtpEmailSender(config.email.smtp, config.email.from);
  }
  return new ConsoleEmailSender(config.email.from);
}

/** Composition root: the only place concrete implementations are wired together. */
export function buildContainer(
  config: AppConfig,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Container {
  const db = overrides.db ?? new Database(createPool(config.database, logger), logger);
  const redis = overrides.redis ?? createRedisClient(config.redis, logger);
  const ttlStore = new RedisTtlStore(redis, config.redis.keyPrefix);
  const infrastructure: Infrastructure = {
    db,
    redis,
    lockManager: new RedisLockManager(redis),
    ttlStore,
  };

  // Repositories
  const users = new UserRepository(db);
  const venues = new VenueRepository(db);
  const events = new EventRepository(db);
  const seatMaps = new SeatMapRepository(db);

  // Services
  const healthService = new HealthService(
    [new PostgresHealthProbe(db), new RedisHealthProbe(redis)],
    {
      timeoutMs: 3_000,
      version: APP_VERSION,
      startedAt: new Date(),
    },
  );
  const otpService = new OtpService(ttlStore, {
    ttlSeconds: config.auth.otpTtlSeconds,
    maxAttempts: config.auth.otpMaxAttempts,
    resendCooldownSeconds: config.auth.otpResendCooldownSeconds,
    secret: `otp:${config.auth.jwtSecret}`,
  });
  const tokenService = new TokenService(ttlStore, {
    secret: config.auth.jwtSecret,
    expiresIn: config.auth.jwtExpiresIn,
  });
  const authService = new AuthService(
    users,
    new BcryptPasswordHasher(config.auth.bcryptSaltRounds),
    otpService,
    tokenService,
    overrides.emailSender ?? createEmailSender(config),
    {
      otpBypass: config.isProduction ? false : (overrides.otpBypass ?? config.auth.otpBypass),
      otpTtlSeconds: config.auth.otpTtlSeconds,
      logger,
    },
  );
  const venueService = new VenueService(venues);
  const eventService = new EventService(db, events, seatMaps, venues, {
    defaultCurrency: config.booking.defaultCurrency,
  });
  const discoveryService = new EventDiscoveryService(events, seatMaps);

  let closed = false;

  return {
    infrastructure,
    authenticate: createAuthenticate(authService, config.auth.cookie.name),
    controllers: {
      health: new HealthController(healthService),
      auth: new AuthController(authService, config.auth.cookie),
      venues: new VenueController(venueService),
      organizerEvents: new OrganizerEventController(eventService),
      publicEvents: new PublicEventController(discoveryService),
    },
    async start() {
      if (redis.status === 'wait') await redis.connect();
      await db.ping();
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([db.close(), redis.quit()]);
    },
  };
}
