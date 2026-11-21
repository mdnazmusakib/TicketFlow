import { apiClient, type ApiClient } from '../../lib/apiClient';

export interface ComponentHealth {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, ComponentHealth>;
  timestamp: string;
}

/** GET /api/health/ready — 503 still carries a report, so it is accepted. */
export async function fetchReadiness(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<ReadinessReport> {
  const { data } = await client.get<ReadinessReport>('/health/ready', {
    signal,
    acceptStatuses: [503],
    timeoutMs: 8_000,
  });
  return data;
}
