import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Signed client-IP hand-off from the trusted edge proxy (Vercel Routing Middleware,
 * frontend/middleware.ts) to the API.
 *
 * Forwarding headers such as X-Forwarded-For can be forged by anyone who calls the API
 * directly, so the API only accepts a client IP that the proxy signed with a secret it
 * shares with the API (HMAC-SHA256, never sent to browsers), together with a timestamp
 * that limits replay to a short window.
 *
 * Wire format (v1):
 *   x-tf-client-ip: <ip>
 *   x-tf-proxy-ts:  <unix seconds>
 *   x-tf-proxy-sig: hex(HMAC_SHA256(secret, "v1.<ts>.<ip>"))
 */
export const PROXY_HEADERS = {
  clientIp: 'x-tf-client-ip',
  timestamp: 'x-tf-proxy-ts',
  signature: 'x-tf-proxy-sig',
} as const;

export const PROXY_SIGNATURE_MAX_AGE_SECONDS = 60;

export function signClientIp(secret: string, ip: string, timestampSeconds: number): string {
  return createHmac('sha256', secret).update(`v1.${timestampSeconds}.${ip}`).digest('hex');
}

type HeaderValue = string | string[] | undefined;

const single = (value: HeaderValue): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

/**
 * Returns the signed client IP when the headers carry a valid, fresh signature;
 * null otherwise (missing, malformed, stale, or forged).
 */
export function verifySignedClientIp(
  headers: Record<string, HeaderValue>,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  const ip = single(headers[PROXY_HEADERS.clientIp]);
  const ts = single(headers[PROXY_HEADERS.timestamp]);
  const signature = single(headers[PROXY_HEADERS.signature]);
  if (!ip || !ts || !signature) return null;
  if (isIP(ip) === 0 || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  const timestamp = Number(ts);
  if (Math.abs(nowSeconds - timestamp) > PROXY_SIGNATURE_MAX_AGE_SECONDS) return null;
  const expected = Buffer.from(signClientIp(secret, ip, timestamp), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? ip : null;
}
