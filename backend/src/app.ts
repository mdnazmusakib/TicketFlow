import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { buildCorsOptions } from './config/cors';
import type { Controllers } from './container';
import { createErrorHandler, notFoundHandler } from './middlewares/errorHandler';
import { createRateLimiter } from './middlewares/rateLimiter';
import { requestId } from './middlewares/requestId';
import { createRequestLogger } from './middlewares/requestLogger';
import { createApiRouter } from './routes';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  controllers: Controllers;
}

/**
 * Builds the Express app from injected dependencies (no I/O here), so tests
 * can create it with fakes and the server can create it with real adapters.
 */
export function createApp({ config, logger, controllers }: AppDependencies): Express {
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
  app.use(cors(buildCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(
    '/api',
    createRateLimiter({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      skip: (req) => req.path.startsWith('/health'),
    }),
    createApiRouter(controllers),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, { exposeStack: config.nodeEnv === 'development' }));

  return app;
}
