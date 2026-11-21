import { env } from '../config/env';

/** Mirrors the backend error envelope: { success: false, error: { code, message, details, requestId } }. */
export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ApiErrorDetail[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: ApiErrorDetail[]; requestId?: string };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Treat these non-2xx statuses as successful envelopes (e.g. 503 readiness reports). */
  acceptStatuses?: number[];
}

export interface ApiResult<T> {
  status: number;
  data: T;
  meta?: Record<string, unknown>;
}

type FetchLike = typeof fetch;

function isEnvelope(value: unknown): value is SuccessEnvelope<unknown> | ErrorEnvelope {
  return typeof value === 'object' && value !== null && 'success' in value;
}

/**
 * Thin fetch wrapper: JSON in/out, cookies included (httpOnly JWT), timeouts,
 * and one typed error class for every failure mode.
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (...args) => fetch(...args),
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      throw new ApiError(
        0,
        aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
        aborted ? 'The request was cancelled or timed out' : 'Unable to reach the server',
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const requestId = response.headers.get('x-request-id') ?? undefined;

    if (
      isEnvelope(payload) &&
      payload.success &&
      (response.ok || options.acceptStatuses?.includes(response.status))
    ) {
      return { status: response.status, data: payload.data as T, meta: payload.meta };
    }
    if (isEnvelope(payload) && !payload.success) {
      const { code, message, details, requestId: bodyRequestId } = payload.error;
      throw new ApiError(response.status, code, message, details ?? [], bodyRequestId ?? requestId);
    }
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'Unexpected response from the server',
      [],
      requestId,
    );
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${normalized}${qs ? `?${qs}` : ''}`;
  }
}

export const apiClient = new ApiClient(env.apiBaseUrl);

/** User-facing message for any thrown value. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
