import type { CorsOptions } from 'cors';
import { ForbiddenError } from '../shared/errors/AppError';

/** Strict allowlist CORS: unknown origins are rejected, credentials (cookies) allowed. */
export function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  const allowlist = new Set(allowedOrigins.map((origin) => origin.replace(/\/$/, '')));

  return {
    origin(origin, callback) {
      // Same-origin requests and non-browser clients (curl, health probes) send no Origin.
      if (!origin || allowlist.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new ForbiddenError('Origin not allowed by CORS policy', 'CORS_ORIGIN_DENIED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  };
}
