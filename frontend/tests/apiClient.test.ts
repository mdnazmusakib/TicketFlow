import { ApiClient, ApiError, toErrorMessage } from '../src/lib/apiClient';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  } as unknown as Response;
}

describe('ApiClient', () => {
  it('sends JSON with credentials and unwraps the success envelope', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: { id: 1 }, meta: { page: 1 } }));
    const client = new ApiClient('/api', fetchMock);

    const result = await client.post<{ id: number }>(
      'events',
      { name: 'x' },
      { query: { page: 2, q: 'rock', skip: undefined } },
    );

    expect(result).toEqual({ status: 200, data: { id: 1 }, meta: { page: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/events?page=2&q=rock');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"name":"x"}' });
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
  });

  it('does not send a body or content type for GET', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: [] }));
    await new ApiClient('/api', fetchMock).get('/health/live');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('throws ApiError with the backend error envelope', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid',
          details: [{ path: 'body.email', message: 'Required' }],
          requestId: 'r1',
        },
      }),
    );
    const error = await new ApiClient('/api', fetchMock).get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      requestId: 'r1',
      details: [{ path: 'body.email', message: 'Required' }],
    });
    expect(toErrorMessage(error)).toBe('Invalid');
  });

  it('accepts explicitly allowed non-2xx envelopes (e.g. 503 readiness)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(503, { success: true, data: { status: 'unavailable' } }));
    const result = await new ApiClient('/api', fetchMock).get('/health/ready', {
      acceptStatuses: [503],
    });
    expect(result.status).toBe(503);
    await expect(new ApiClient('/api', fetchMock).get('/health/ready')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('reports network failures and non-JSON responses', async () => {
    const offline = new ApiClient(
      '/api',
      jest.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    const networkError = await offline.get('/x').catch((e: unknown) => e as ApiError);
    expect(networkError).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect((networkError as ApiError).isNetworkError).toBe(true);

    const html = new ApiClient(
      '/api',
      jest.fn().mockResolvedValue(jsonResponse(502, undefined, { 'x-request-id': 'abc' })),
    );
    await expect(html.get('/x')).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
      requestId: 'abc',
    });
  });

  it('aborts on timeout or caller cancellation', async () => {
    const hanging = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = new ApiClient('/api', hanging as unknown as typeof fetch);
    await expect(client.get('/slow', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'REQUEST_ABORTED',
    });

    const controller = new AbortController();
    const pending = client.get('/slow', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('gives a generic message for unknown errors', () => {
    expect(toErrorMessage(new Error('internal'))).toBe('Something went wrong. Please try again.');
  });
});
