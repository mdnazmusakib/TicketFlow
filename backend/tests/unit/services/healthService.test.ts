import { PostgresHealthProbe, RedisHealthProbe, type HealthProbe } from '../../../src/repositories/HealthProbes';
import { HealthService } from '../../../src/services/HealthService';

const probe = (name: string, check: HealthProbe['check']): HealthProbe => ({ name, check });

describe('HealthService', () => {
  it('reports liveness with uptime and version', () => {
    const service = new HealthService([], {
      timeoutMs: 100,
      version: '1.2.3',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const report = service.liveness(new Date('2026-01-01T00:01:30Z'));
    expect(report).toEqual({
      status: 'ok',
      uptimeSeconds: 90,
      version: '1.2.3',
      timestamp: '2026-01-01T00:01:30.000Z',
    });
    expect(new HealthService([], { timeoutMs: 1, version: 'x' }).liveness().uptimeSeconds).toBe(0);
  });

  it('is ready when every probe passes and includes probe details', async () => {
    const service = new HealthService(
      [probe('database', async () => ({ schemaVersion: '0006' })), probe('redis', async () => undefined)],
      { timeoutMs: 100, version: 'x' },
    );
    const report = await service.readiness();
    expect(report.status).toBe('ok');
    expect(report.checks.database).toMatchObject({ status: 'up', details: { schemaVersion: '0006' } });
    expect(report.checks.redis).toEqual({ status: 'up', latencyMs: expect.any(Number) });
  });

  it('is unavailable when a probe fails, without leaking error messages', async () => {
    const service = new HealthService(
      [
        probe('database', async () => {
          throw Object.assign(new Error('password authentication failed for user postgres'), { code: 'ECONNREFUSED' });
        }),
        probe('redis', async () => {
          throw new Error('secret detail');
        }),
      ],
      { timeoutMs: 100, version: 'x' },
    );
    const report = await service.readiness();
    expect(report.status).toBe('unavailable');
    expect(report.checks.database).toMatchObject({ status: 'down', error: 'unreachable (ECONNREFUSED)' });
    expect(report.checks.redis).toMatchObject({ status: 'down', error: 'unreachable' });
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('times out hanging probes', async () => {
    const service = new HealthService([probe('redis', () => new Promise(() => undefined))], {
      timeoutMs: 20,
      version: 'x',
    });
    const report = await service.readiness();
    expect(report.checks.redis).toMatchObject({ status: 'down', error: 'timed out after 20ms' });
  });

  it('summarises non-Error rejections', async () => {
    const service = new HealthService([probe('x', () => Promise.reject('nope'))], { timeoutMs: 50, version: 'x' });
    expect((await service.readiness()).checks.x?.error).toBe('unreachable');
  });
});

describe('health probes', () => {
  it('RedisHealthProbe requires PONG', async () => {
    await expect(new RedisHealthProbe({ ping: async () => 'PONG' }).check()).resolves.toBeUndefined();
    await expect(new RedisHealthProbe({ ping: async () => 'NOPE' }).check()).rejects.toThrow('Unexpected PING reply');
  });

  it('PostgresHealthProbe reports null schema version before migrations', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ migrated: false }] });
    await expect(new PostgresHealthProbe({ query } as never).check()).resolves.toEqual({ schemaVersion: null });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
