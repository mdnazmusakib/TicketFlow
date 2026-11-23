/**
 * Vercel Routing Middleware: same-origin proxy from the web app to the TicketFlow API
 * that also tells the API who the real client is, in a way the client cannot forge.
 *
 * Why: the API sees Vercel's address for every proxied request, and plain forwarding
 * headers (X-Forwarded-For, X-Real-IP, X-Vercel-Forwarded-For) can be typed by anyone who
 * calls the API directly. So this middleware takes the client IP from the request Vercel
 * received (Vercel sets X-Real-IP / X-Forwarded-For itself at its edge) and signs it with
 * TRUSTED_PROXY_SECRET, a server-side secret shared only with the API. The API trusts
 * the IP only if the HMAC verifies and the timestamp is fresh (60 s).
 *
 * Environment (Vercel project, server-side only; never VITE_*):
 *   API_ORIGIN            e.g. https://ticketflow-dev.onrender.com
 *   TRUSTED_PROXY_SECRET  same value as on the API (>= 32 random characters)
 * If either is missing the middleware does nothing and vercel.json rewrites still proxy
 * the request (unsigned, so the API rate-limits it by Vercel's address).
 */
export const config = { matcher: ['/api/:path*', '/uploads/:path*'] };

const SIGNED_HEADERS = ['x-tf-client-ip', 'x-tf-proxy-ts', 'x-tf-proxy-sig'];
// Hop-by-hop or rewritten headers that must not be copied to the upstream request/response.
const DROP_REQUEST_HEADERS = ['host', 'connection', 'content-length', ...SIGNED_HEADERS];
const DROP_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

/** Client IP as seen by Vercel's edge (X-Real-IP, else the first X-Forwarded-For entry). */
export function clientIpFrom(headers: Headers): string | null {
  const candidate =
    headers.get('x-real-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return candidate && IP_PATTERN.test(candidate) ? candidate : null;
}

export async function signClientIp(secret: string, ip: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${ts}.${ip}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface ProxyEnv {
  API_ORIGIN?: string;
  TRUSTED_PROXY_SECRET?: string;
}

export async function proxyToApi(
  request: Request,
  env: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response | undefined> {
  const origin = env.API_ORIGIN?.replace(/\/+$/, '');
  const secret = env.TRUSTED_PROXY_SECRET;
  if (!origin || !secret || secret.length < 32) return undefined; // fall back to vercel.json

  const url = new URL(request.url);
  const target = `${origin}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  for (const name of DROP_REQUEST_HEADERS) headers.delete(name);

  const ip = clientIpFrom(request.headers);
  if (ip) {
    const ts = Math.floor(now() / 1000);
    headers.set('x-tf-client-ip', ip);
    headers.set('x-tf-proxy-ts', String(ts));
    headers.set('x-tf-proxy-sig', await signClientIp(secret, ip, ts));
  }

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = await fetchImpl(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    // Required by the fetch spec when streaming a request body.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);

  const responseHeaders = new Headers(upstream.headers);
  for (const name of DROP_RESPONSE_HEADERS) responseHeaders.delete(name);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default function middleware(request: Request): Promise<Response | undefined> {
  return proxyToApi(request, {
    API_ORIGIN: process.env.API_ORIGIN,
    TRUSTED_PROXY_SECRET: process.env.TRUSTED_PROXY_SECRET,
  });
}
