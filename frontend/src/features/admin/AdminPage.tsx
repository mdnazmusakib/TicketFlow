import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorMessage, Pagination } from '../../components/ui/Feedback';
import { SelectField, TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { StatGrid, StatusCounts } from '../../components/ui/Stats';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { Role } from '../auth/authApi';
import { dashboardApi as defaultApi, type DashboardApi } from '../dashboard/dashboardApi';

function PlatformOverview({ api }: { api: DashboardApi }) {
  const overview = useAsync(useCallback((signal: AbortSignal) => api.adminOverview(signal), [api]));
  if (overview.status === 'loading') return <Spinner label="Loading platform overview" />;
  if (overview.status === 'error') {
    return <ErrorMessage message={toErrorMessage(overview.error)} onRetry={overview.reload} />;
  }
  const data = overview.data;
  return (
    <>
      <StatGrid
        label="Platform totals"
        stats={[
          {
            label: 'Users',
            value: data.users.customers + data.users.organizers + data.users.admins,
            hint: `${data.users.customers} customers · ${data.users.organizers} organizers · ${data.users.admins} admins`,
          },
          { label: 'Events', value: data.events },
          { label: 'Bookings', value: data.bookings },
          { label: 'Payments captured', value: formatMoney(data.paidMinor) },
          { label: 'Refunded', value: formatMoney(data.refundedMinor) },
          {
            label: 'Needs attention',
            value: data.failedRefunds + data.openPayments,
            hint: `${data.failedRefunds} failed refunds · ${data.openPayments} open payments`,
          },
        ]}
      />
      <div className="dashboard__columns">
        <div className="card">
          <h2>Bookings by status</h2>
          <StatusCounts counts={data.bookingsByStatus} label="Bookings by status" />
          <h2>Events by status</h2>
          <StatusCounts counts={data.eventsByStatus} label="Events by status" />
        </div>
        <div className="card">
          <h2>Notification delivery</h2>
          <StatusCounts
            counts={data.notificationDelivery}
            label="Notification delivery"
            empty="No notifications sent yet"
          />
          <p className="muted">
            Failed notifications retry automatically with backoff. Manage all events from the{' '}
            <Link to="/organizer">organizer dashboard</Link>.
          </p>
        </div>
      </div>
    </>
  );
}

function UserDirectory({ api }: { api: DashboardApi }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [page, setPage] = useState(1);

  // Debounce typing so every keystroke is not a request.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const users = useAsync(
    useCallback(
      (signal: AbortSignal) =>
        api.adminUsers({ q: q || undefined, role: role || undefined, page, pageSize: 20 }, signal),
      [api, q, role, page],
    ),
    `${q}:${role}:${page}`,
  );

  return (
    <section className="card" aria-labelledby="users-heading">
      <h2 id="users-heading">Users</h2>
      <div className="filters">
        <TextField
          label="Search name or email"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value as Role | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'All roles' },
            { value: 'CUSTOMER', label: 'Customer' },
            { value: 'ORGANIZER', label: 'Organizer' },
            { value: 'ADMIN', label: 'Admin' },
          ]}
        />
      </div>
      {users.status === 'loading' && <Spinner label="Loading users" />}
      {users.status === 'error' && (
        <ErrorMessage message={toErrorMessage(users.error)} onRetry={users.reload} />
      )}
      {users.status === 'success' && users.data.items.length === 0 && (
        <EmptyState title="No users match" />
      )}
      {users.status === 'success' && users.data.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>{user.name}</td>
                    <td>{user.email}</td>
                    <td>{user.role}</td>
                    <td>
                      {!user.isActive ? 'Disabled' : user.emailVerified ? 'Active' : 'Unverified'}
                    </td>
                    <td>{formatDateTime(user.createdAt)}</td>
                    <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={users.data.meta.page}
            totalPages={users.data.meta.totalPages}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}

/** Admin console: platform health/statistics and the user directory (ADMIN only; API enforced). */
export function AdminPage({ api = defaultApi }: { api?: DashboardApi }) {
  return (
    <div className="dashboard">
      <div className="page-header">
        <h1>Admin console</h1>
      </div>
      <PlatformOverview api={api} />
      <UserDirectory api={api} />
    </div>
  );
}
