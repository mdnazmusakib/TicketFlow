/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto';
import { clientIpFrom, proxyToApi, signClientIp } from '../middleware';

const SECRET = 'shared-proxy-secret-0123456789abcdef';
const env = { API_ORIGIN: 'https://api.example.com/', TRUSTED_PROXY_SECRET: SECRET };

describe('Vercel proxy middleware', () => {
  it('signs exactly what the API verifies (HMAC-SHA256 over "v1.<ts>.<ip>")', async () => {
    const expected = createHmac('sha256', SECRET).update('v1.1800000000.192.0.2.7').digest('hex');
    await expect(signClientIp(SECRET, '192.0.2.7', 1_800_000_000)).resolves.toBe(expected);
  });

  it('reads the client IP from Vercel headers and rejects junk', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '192.0.2.1' }))).toBe('192.0.2.1');
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '2001:db8::5, 10.0.0.1' }))).toBe(
      '2001:db8::5',
    );
    expect(clientIpFrom(new Headers({ 'x-real-ip': '<script>' }))).toBeNull();
    expect(clientIpFrom(new Headers())).toBeNull();
  });

  it('proxies to the API with a fresh signature and drops client-supplied signature headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'tf_session=abc; HttpOnly; Secure; SameSite=Lax; Path=/',
          'content-encoding': 'br',
        },
      }),
    );
    const request = new Request('https://app.vercel.app/api/auth/login?x=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.vercel.app',
        'x-real-ip': '192.0.2.44',
        'x-tf-client-ip': '6.6.6.6', // forged by the client
        'x-tf-proxy-sig': 'f'.repeat(64),
      },
      body: JSON.stringify({ email: 'a@example.com', password: 'x' }),
    });
    const response = await proxyToApi(request, env, fetchMock, () => 1_800_000_000_000);

    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('https://api.example.com/api/auth/login?x=1');
    const sent = init.headers as Headers;
    expect(sent.get('x-tf-client-ip')).toBe('192.0.2.44');
    expect(sent.get('x-tf-proxy-ts')).toBe('1800000000');
    expect(sent.get('x-tf-proxy-sig')).toBe(
      await signClientIp(SECRET, '192.0.2.44', 1_800_000_000),
    );
    expect(sent.get('origin')).toBe('https://app.vercel.app');
    expect(sent.get('host')).toBeNull();
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');

    expect(response!.status).toBe(201);
    expect(response!.headers.get('set-cookie')).toContain('tf_session=abc');
    expect(response!.headers.get('content-encoding')).toBeNull();
    await expect(response!.json()).resolves.toEqual({ ok: true });
  });

  it('does nothing without configuration (vercel.json rewrites take over)', async () => {
    const fetchMock = jest.fn();
    const request = new Request('https://app.vercel.app/api/events');
    await expect(proxyToApi(request, {}, fetchMock)).resolves.toBeUndefined();
    await expect(
      proxyToApi(
        request,
        { API_ORIGIN: 'https://api.example.com', TRUSTED_PROXY_SECRET: 'short' },
        fetchMock,
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards GET requests without a body and without a client IP signature when none is known', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    await proxyToApi(new Request('https://app.vercel.app/uploads/x.png'), env, fetchMock);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('https://api.example.com/uploads/x.png');
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get('x-tf-proxy-sig')).toBeNull();
  });
});
