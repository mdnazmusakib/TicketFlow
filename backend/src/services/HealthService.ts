import type { HealthProbe } from '../repositories/HealthProbes';

export type ComponentStatus = 'up' | 'down';

export interface ComponentHealth {
  status: ComponentStatus;
  latencyMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, ComponentHealth>;
  timestamp: string;
}

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
  version: string;
  timestamp: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Aggregates dependency probes. Probe errors are summarised as a short,
 * non-sensitive reason (never connection strings or stack traces).
 */
export class HealthService {
  constructor(
    private readonly probes: readonly HealthProbe[],
    private readonly options: { timeoutMs: number; version: string; startedAt?: Date },
  ) {}

  liveness(now: Date = new Date()): LivenessReport {
    const startedAt = this.options.startedAt ?? now;
    return {
      status: 'ok',
      uptimeSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
      version: this.options.version,
      timestamp: now.toISOString(),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.probes.map(async (probe): Promise<[string, ComponentHealth]> => {
        const started = performance.now();
        try {
          const details = await withTimeout(probe.check(), this.options.timeoutMs);
          const latencyMs = Math.round(performance.now() - started);
          return [probe.name, details ? { status: 'up', latencyMs, details } : { status: 'up', latencyMs }];
        } catch (error) {
          return [
            probe.name,
            {
              status: 'down',
              latencyMs: Math.round(performance.now() - started),
              error: summarize(error),
            },
          ];
        }
      }),
    );

    const checks = Object.fromEntries(entries);
    const allUp = entries.every(([, health]) => health.status === 'up');
    return { status: allUp ? 'ok' : 'unavailable', checks, timestamp: new Date().toISOString() };
  }
}

function summarize(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.startsWith('timed out')) return error.message;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `unreachable (${code})` : 'unreachable';
  }
  return 'unreachable';
}
