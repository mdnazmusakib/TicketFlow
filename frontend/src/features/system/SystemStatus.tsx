import { toErrorMessage } from '../../lib/apiClient';
import { useAsync } from '../../lib/useAsync';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { fetchReadiness, type ReadinessReport } from './healthApi';

const LABELS: Record<string, string> = { database: 'Database', redis: 'Cache & locks' };

interface Props {
  load?: (signal: AbortSignal) => Promise<ReadinessReport>;
}

/** Live backend readiness (PostgreSQL + Redis). */
export function SystemStatus({ load = fetchReadiness }: Props) {
  const state = useAsync(load);

  return (
    <section className="card" aria-labelledby="system-status-title">
      <div className="card__header">
        <h2 id="system-status-title">System status</h2>
        <Button variant="ghost" onClick={state.reload} disabled={state.status === 'loading'}>
          Refresh
        </Button>
      </div>

      {state.status === 'loading' && <Spinner label="Checking services" />}

      {state.status === 'error' && (
        <p role="alert" className="status status--down">
          API unreachable: {toErrorMessage(state.error)}
        </p>
      )}

      {state.status === 'success' && (
        <>
          <p className={`status ${state.data.status === 'ok' ? 'status--up' : 'status--down'}`}>
            {state.data.status === 'ok'
              ? 'All systems operational'
              : 'Some services are unavailable'}
          </p>
          <ul className="status-list">
            {Object.entries(state.data.checks).map(([name, check]) => (
              <li key={name}>
                <span>{LABELS[name] ?? name}</span>
                <span className={`badge ${check.status === 'up' ? 'badge--up' : 'badge--down'}`}>
                  {check.status === 'up' ? `Up · ${check.latencyMs} ms` : 'Down'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
