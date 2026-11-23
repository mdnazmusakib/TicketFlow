import rateLimit, { ipKeyGenerator, type Options, type Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { RateLimitError } from '../shared/errors/AppError';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Shared store (e.g. Redis) for multi-instance deployments; defaults to memory. */
  store?: Store;
  /** Skip limiting for some requests (e.g. health probes). */
  skip?: Options['skip'];
}

/**
 * Factory so routes can apply stricter limits (auth, holds, payments) than the
 * global API limiter. Rejections flow through the central error handler.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Identity from the clientIp middleware (proxy-signed IP or req.ip within TRUST_PROXY
    // hops), never a raw client-supplied header. IPv6 clients are grouped by /56 subnet.
    keyGenerator: (req) => ipKeyGenerator(req.clientIp ?? req.ip ?? 'unknown'),
    ...(options.store ? { store: options.store } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
    handler: (_req, _res, next) => next(new RateLimitError()),
  });
}
