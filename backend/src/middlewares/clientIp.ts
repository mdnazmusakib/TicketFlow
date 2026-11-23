import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { verifySignedClientIp } from '../shared/security/trustedProxy';
import { AppError } from '../shared/errors/AppError';

export interface ClientIpOptions {
  /** Shared with the edge proxy (TRUSTED_PROXY_SECRET); unset = no proxy signatures. */
  proxySecret?: string | undefined;
  /** Reject unsigned requests to non-public paths (REQUIRE_TRUSTED_PROXY). */
  requireTrustedProxy: boolean;
  /** Edge-overwritten client IP header (CLIENT_IP_HEADER), e.g. cf-connecting-ip. */
  clientIpHeader?: string | undefined;
}

function headerIp(value: string | string[] | undefined): string | null {
  const ip = typeof value === 'string' ? value.trim() : '';
  return isIP(ip) !== 0 ? ip : null;
}

/**
 * Paths that must keep working without the edge proxy: health checks (Render),
 * payment provider callbacks (SSLCommerz IPN/returns, mock webhooks) and public images
 * (banner URLs point at the API host).
 */
const DIRECT_ACCESS_ALLOWED = [
  /^\/api\/health(\/|$)/,
  /^\/api\/payments\/webhooks\//,
  /^\/api\/payments\/providers\//,
  /^\/uploads\//,
];

/**
 * Resolves the identity used by IP-based rate limits (req.clientIp):
 * 1. a client IP signed by the trusted edge proxy (Vercel → API), else
 * 2. CLIENT_IP_HEADER, when configured (a header the hosting edge always overwrites), else
 * 3. req.ip, which Express derives from X-Forwarded-For using TRUST_PROXY hops only:
 *    entries a client wrote further left are ignored, so TRUST_PROXY must equal the real
 *    number of proxies (check with GET /api/admin/diagnostics/request after deploying).
 * Unsigned forwarding headers are never trusted beyond the configured hop count.
 */
export function createClientIpMiddleware(options: ClientIpOptions): RequestHandler {
  return (req, _res, next) => {
    const signed = options.proxySecret
      ? verifySignedClientIp(req.headers, options.proxySecret)
      : null;
    req.viaTrustedProxy = signed !== null;
    const fromHeader = options.clientIpHeader
      ? headerIp(req.headers[options.clientIpHeader])
      : null;
    req.clientIp = signed ?? fromHeader ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (
      options.requireTrustedProxy &&
      !req.viaTrustedProxy &&
      !DIRECT_ACCESS_ALLOWED.some((pattern) => pattern.test(req.path))
    ) {
      next(
        new AppError(403, 'FORBIDDEN', 'Direct API access is not allowed; use the web application'),
      );
      return;
    }
    next();
  };
}
