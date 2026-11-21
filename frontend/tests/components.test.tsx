import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../src/app/routes';
import { ErrorBoundary } from '../src/components/feedback/ErrorBoundary';
import { AuthProvider } from '../src/features/auth/AuthContext';
import { anonymousAuthApi } from './testUtils';
import { DemoCredentials } from '../src/features/auth/DemoCredentials';
import { DEMO_ACCOUNTS } from '../src/features/auth/demoAccounts';
import { SystemStatus } from '../src/features/system/SystemStatus';
import { fetchReadiness, type ReadinessReport } from '../src/features/system/healthApi';
import { ApiClient, ApiError } from '../src/lib/apiClient';

const healthy: ReadinessReport = {
  status: 'ok',
  timestamp: '2026-11-21T00:00:00Z',
  checks: { database: { status: 'up', latencyMs: 12 }, redis: { status: 'up', latencyMs: 3 } },
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <AuthProvider api={anonymousAuthApi()}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}

describe('SystemStatus', () => {
  it('shows each dependency when the API is healthy', async () => {
    render(<SystemStatus load={async () => healthy} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking services');
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Up · 12 ms')).toBeInTheDocument();
    expect(screen.getByText('Cache & locks')).toBeInTheDocument();
  });

  it('shows degraded state when a dependency is down', async () => {
    const degraded: ReadinessReport = {
      ...healthy,
      status: 'unavailable',
      checks: { ...healthy.checks, redis: { status: 'down', latencyMs: 2000 } },
    };
    render(<SystemStatus load={async () => degraded} />);
    expect(await screen.findByText('Some services are unavailable')).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
  });

  it('shows an error and can retry', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server'))
      .mockResolvedValueOnce(healthy);
    render(<SystemStatus load={load} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'API unreachable: Unable to reach the server',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fetchReadiness calls the readiness endpoint and accepts 503 reports', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { ...healthy, status: 'unavailable' } }),
    });
    const report = await fetchReadiness(undefined, new ApiClient('/api', fetchMock));
    expect(report.status).toBe('unavailable');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health/ready');
  });
});

describe('DemoCredentials', () => {
  it('lists the demo organizer and customer accounts', () => {
    render(<DemoCredentials />);
    for (const account of DEMO_ACCOUNTS) {
      expect(screen.getByText(account.email)).toBeInTheDocument();
    }
    expect(screen.getByText('Organizer')).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('lets a form pick an account', async () => {
    const onSelect = jest.fn();
    render(<DemoCredentials onSelect={onSelect} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Use' })[0]!);
    expect(onSelect).toHaveBeenCalledWith(DEMO_ACCOUNTS[0]);
  });
});

describe('routing and layout', () => {
  beforeEach(() => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data: healthy }),
    }) as unknown as typeof fetch;
  });

  it('renders the home page inside the layout', async () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: /book tickets/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ticketflow/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', () => {
    renderAt('/missing/page');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('toggles the mobile navigation', async () => {
    renderAt('/');
    const toggle = screen.getByRole('button', { name: /toggle navigation/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('render failure');
  }

  it('renders a fallback, reports the error and can reset', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = jest.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('renders route errors through the router error element', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter(
      [{ path: '/', element: <Boom />, errorElement: routes[0]!.errorElement }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
