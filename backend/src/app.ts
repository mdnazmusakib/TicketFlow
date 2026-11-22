import cookieParser from 'cookie-parser';
import cors from 'cors';
import type { RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { buildCorsOptions } from './config/cors';
import type { Controllers } from './container';
import { createErrorHandler, notFoundHandler } from './middlewares/errorHandler';
import { createRateLimiter } from './middlewares/rateLimiter';
import { requestId } from './middlewares/requestId';
import { createFrontendRouter } from './middlewares/spa';
import { createRequestLogger } from './middlewares/requestLogger';
import { createApiRouter } from './routes';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  controllers: Controllers;
  authenticate: RequestHandler;
  /** Shared limiter storage (Redis) so limits hold across instances; memory when omitted. */
  rateLimitStore?: (name: string) => Store;
}

/**
 * Builds the Express app from injected dependencies (no I/O here), so tests
 * can create it with fakes and the server can create it with real adapters.
 */
export function createApp({
  config,
  logger,
  controllers,
  authenticate,
  rateLimitStore,
}: AppDependencies): Express {
  const store = (name: string) => (rateLimitStore ? { store: rateLimitStore(name) } : {});
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('env', config.isProduction ? 'production' : config.nodeEnv);

  app.use(requestId);
  app.use(createRequestLogger(logger));
  app.use(
    helmet({
      // API only serves JSON; lock everything down.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  // Payment providers post server-to-server (webhooks/IPN) or redirect the browser with a
  // form POST from their domain; those routes carry no session and are authenticated by
  // signatures + server-side verification instead, so the browser CORS allowlist is skipped.
  const corsMiddleware = cors(buildCorsOptions(config.corsOrigins));
  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/payments/webhooks/') ||
      req.path.startsWith('/api/payments/providers/')
    ) {
      next();
      return;
    }
    corsMiddleware(req, res, next);
  });
  // JSON only: HTML forms (urlencoded) are not accepted, which removes a classic CSRF vector.
  app.use(
    express.json({
      limit: '100kb',
      // Raw bytes are kept for webhook signature verification.
      verify: (req, _res, buffer) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buffer;
      },
    }),
  );
  app.use(cookieParser());

  const authLimiter = createRateLimiter({
    ...store('auth'),
    windowMs: config.rateLimit.windowMs,
    max: config.auth.rateLimitMax,
  });
  const bookingLimiter = createRateLimiter({
    ...store('booking'),
    windowMs: config.rateLimit.windowMs,
    max: config.booking.rateLimitMax,
  });

  // Public, read-only image delivery (keys are validated; see UploadController.serve).
  app.get(
    '/uploads/:key',
    createRateLimiter({
      ...store('uploads'),
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max * 5,
    }),
    controllers.uploads.serve,
  );

  app.use(
    '/api',
    createRateLimiter({
      ...store('api'),
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      skip: (req) => req.path.startsWith('/health'),
    }),
    createApiRouter(controllers, { authenticate, authLimiter, bookingLimiter }),
  );

  if (config.frontendDistDir) app.use(createFrontendRouter(config.frontendDistDir));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, { exposeStack: config.nodeEnv === 'development' }));

  return app;
}
