import type { RequestHandler } from 'express';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { AuthController } from './controllers/AuthController';
import { BookingController } from './controllers/BookingController';
import {
  OrganizerEventController,
  PublicEventController,
  VenueController,
} from './controllers/EventController';
import { HealthController } from './controllers/HealthController';
import { PaymentController } from './controllers/PaymentController';
import type { EmailSender } from './domain/notifications/email';
import { PaymentGatewayRegistry, type PaymentGateway } from './domain/payments/PaymentGateway';
import { PricingStrategyRegistry } from './domain/pricing/PricingStrategy';
import { Database } from './infrastructure/database/Database';
import { createPool } from './infrastructure/database/pool';
import { ConsoleEmailSender } from './infrastructure/email/ConsoleEmailSender';
import { SmtpEmailSender } from './infrastructure/email/SmtpEmailSender';
import { MockPaymentLedger } from './infrastructure/payments/MockPaymentLedger';
import { MockProviderA, MockProviderB } from './infrastructure/payments/MockProviders';
import { SslCommerzAdapter } from './infrastructure/payments/SslCommerzAdapter';
import { createRedisClient } from './infrastructure/redis/client';
import { RedisLockManager, type LockManager } from './infrastructure/redis/LockManager';
import { RedisTtlStore, type TtlStore } from './infrastructure/redis/TtlStore';
import { BcryptPasswordHasher } from './infrastructure/security/PasswordHasher';
import { createAuthenticate } from './middlewares/auth';
import { BookingRepository } from './repositories/BookingRepository';
import { EventRepository } from './repositories/EventRepository';
import { PostgresHealthProbe, RedisHealthProbe } from './repositories/HealthProbes';
import { IdempotencyRepository } from './repositories/IdempotencyRepository';
import { PaymentRepository } from './repositories/PaymentRepository';
import { SeatMapRepository } from './repositories/SeatMapRepository';
import { UserRepository } from './repositories/UserRepository';
import { VenueRepository } from './repositories/VenueRepository';
import { AuthService } from './services/auth/AuthService';
import { OtpService } from './services/auth/OtpService';
import { TokenService } from './services/auth/TokenService';
import { BookingExpiryService } from './services/booking/BookingExpiryService';
import { BookingLifecycle } from './services/booking/BookingLifecycle';
import { BookingService } from './services/booking/BookingService';
import { SeatLockCoordinator } from './services/booking/SeatLockCoordinator';
import { EventDiscoveryService } from './services/events/EventDiscoveryService';
import { EventService } from './services/events/EventService';
import { VenueService } from './services/events/VenueService';
import { HealthService } from './services/HealthService';
import { CancellationService } from './services/payments/CancellationService';
import { IdempotencyService } from './services/payments/IdempotencyService';
import { MockCheckoutService } from './services/payments/MockCheckoutService';
import { PaymentService, toPaymentDto } from './services/payments/PaymentService';
import { RefundService, toRefundDto } from './services/payments/RefundService';
import { WebhookService } from './services/payments/WebhookService';
import { APP_VERSION } from './version';
import { BookingExpiryWorker } from './workers/BookingExpiryWorker';

export interface Controllers {
  health: HealthController;
  auth: AuthController;
  venues: VenueController;
  organizerEvents: OrganizerEventController;
  publicEvents: PublicEventController;
  bookings: BookingController;
  payments: PaymentController;
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
  services: {
    bookings: BookingService;
    bookingExpiry: BookingExpiryService;
    payments: PaymentService;
    refunds: RefundService;
    cancellations: CancellationService;
    webhooks: WebhookService;
  };
  gateways: PaymentGatewayRegistry;
  expiryWorker: BookingExpiryWorker;
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
  /** Clock for business rules (24-hour refund window, pricing). */
  now?: () => Date;
  /** Replaces/extends the configured payment gateways (e.g. SSLCommerz with a fake HTTP client). */
  paymentGateways?: PaymentGateway[];
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

  // Payment gateways (adapters); booking code only sees the PaymentGateway interface.
  const mockLedger = new MockPaymentLedger(ttlStore);
  const mockProviderA = config.payments.mockEnabled
    ? new MockProviderA(mockLedger, {
        checkoutUrl: `${config.urls.frontend}/payments/mock-checkout`,
        webhookSecret: config.payments.mockWebhookSecret,
      })
    : null;
  const gateways = new PaymentGatewayRegistry();
  if (mockProviderA) {
    gateways.register(mockProviderA);
    gateways.register(
      new MockProviderB(mockLedger, { webhookSecret: config.payments.mockWebhookSecret }),
    );
  }
  if (config.payments.sslcommerz) {
    gateways.register(
      new SslCommerzAdapter({
        storeId: config.payments.sslcommerz.storeId,
        storePassword: config.payments.sslcommerz.storePassword,
        sandbox: config.payments.sslcommerz.sandbox,
        publicApiUrl: config.urls.publicApi,
        defaultCustomerPhone: config.payments.sslcommerz.customerPhone,
      }),
    );
  }
  for (const gateway of overrides.paymentGateways ?? []) gateways.register(gateway);
  const paymentRepository = new PaymentRepository(db);

  // Booking
  const bookingRepository = new BookingRepository(db);
  const lifecycle = new BookingLifecycle(bookingRepository);
  const seatLocks = new SeatLockCoordinator(infrastructure.lockManager, ttlStore, {
    acquireTtlMs: 15_000,
    logger,
    isBookingActive: (bookingId) => bookingRepository.isLockOwnerActive(db, bookingId),
  });
  const bookingExpiry = new BookingExpiryService(
    db,
    bookingRepository,
    lifecycle,
    seatLocks,
    logger,
  );
  const bookingService = new BookingService(
    db,
    bookingRepository,
    lifecycle,
    bookingExpiry,
    seatLocks,
    new PricingStrategyRegistry(),
    {
      maxTicketsPerUserPerEvent: config.booking.maxTicketsPerUserPerEvent,
      holdTtlSeconds: config.booking.seatHoldTtlSeconds,
      logger,
      ...(overrides.now ? { now: overrides.now } : {}),
      financials: async (bookingId) => ({
        payments: (await paymentRepository.listForBooking(bookingId)).map((p) => ({
          ...toPaymentDto(p),
        })),
        refunds: (await paymentRepository.refundsForBooking(bookingId)).map((r) => ({
          ...toRefundDto(r),
        })),
      }),
    },
  );

  // Payments, refunds, cancellation
  const refundService = new RefundService(db, paymentRepository, gateways, {
    maxAttempts: config.payments.refundMaxAttempts,
    logger,
  });
  const paymentService = new PaymentService(
    db,
    paymentRepository,
    bookingRepository,
    bookingService,
    lifecycle,
    users,
    gateways,
    new IdempotencyService(new IdempotencyRepository(db)),
    refundService,
    seatLocks,
    {
      holdExtensionSeconds: config.payments.holdExtensionSeconds,
      logger,
      mockProviderBTokens: MockProviderB.TOKENS,
    },
  );
  const webhookService = new WebhookService(gateways, paymentRepository, paymentService, logger);
  const cancellationService = new CancellationService(
    db,
    bookingRepository,
    paymentRepository,
    bookingService,
    lifecycle,
    paymentService,
    refundService,
    { logger, ...(overrides.now ? { now: overrides.now } : {}) },
  );

  const expiryWorker = new BookingExpiryWorker(
    {
      // Resolve payments first so a completed payment confirms instead of expiring.
      expireDue: async () => {
        await paymentService.reconcileOpen();
        const expired = await bookingExpiry.expireDue();
        await refundService.processDue();
        return expired;
      },
    },
    {
      intervalMs: config.booking.expiryIntervalMs,
      logger,
    },
  );

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
      bookings: new BookingController(bookingService, cancellationService),
      payments: new PaymentController(
        paymentService,
        webhookService,
        new MockCheckoutService(mockProviderA, paymentService, webhookService),
        { frontendUrl: config.urls.frontend },
      ),
    },
    services: {
      bookings: bookingService,
      bookingExpiry,
      payments: paymentService,
      refunds: refundService,
      cancellations: cancellationService,
      webhooks: webhookService,
    },
    gateways,
    expiryWorker,
    async start() {
      if (redis.status === 'wait') await redis.connect();
      await db.ping();
    },
    async close() {
      if (closed) return;
      closed = true;
      await expiryWorker.stop();
      await Promise.allSettled([db.close(), redis.quit()]);
    },
  };
}
