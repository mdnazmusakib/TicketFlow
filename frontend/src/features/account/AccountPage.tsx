import { useCallback } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorMessage } from '../../components/ui/Feedback';
import { Spinner } from '../../components/ui/Spinner';
import { StatGrid } from '../../components/ui/Stats';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { User } from '../auth/authApi';
import { useAuth } from '../auth/AuthContext';
import { dashboardApi as defaultApi, type DashboardApi } from '../dashboard/dashboardApi';
import { NotificationItem } from '../notifications/NotificationsPage';

function Profile({ user }: { user: User }) {
  return (
    <section className="card" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <dl className="details">
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Member since</dt>
        <dd>{formatDateTime(user.createdAt)}</dd>
      </dl>
    </section>
  );
}

/** Customer dashboard: stats, upcoming bookings and recent notifications. */
function CustomerDashboard({ api }: { api: DashboardApi }) {
  const dashboard = useAsync(useCallback((signal: AbortSignal) => api.customer(signal), [api]));
  if (dashboard.status === 'loading') return <Spinner label="Loading your dashboard" />;
  if (dashboard.status === 'error') {
    return <ErrorMessage message={toErrorMessage(dashboard.error)} onRetry={dashboard.reload} />;
  }
  const { stats, upcoming, recentNotifications, unreadNotifications } = dashboard.data;
  const currency = upcoming[0]?.currency ?? 'BDT';
  return (
    <>
      <StatGrid
        label="Booking summary"
        stats={[
          { label: 'Bookings', value: stats.totalBookings },
          { label: 'Upcoming events', value: stats.upcomingBookings },
          { label: 'Total paid', value: formatMoney(stats.paidMinor, currency) },
          {
            label: 'Refunded',
            value: formatMoney(stats.refundedMinor, currency),
            hint:
              stats.refundsInProgress > 0 ? `${stats.refundsInProgress} in progress` : undefined,
          },
        ]}
      />
      <div className="dashboard__columns">
        <section className="card" aria-labelledby="upcoming-heading">
          <div className="card__header">
            <h2 id="upcoming-heading">Upcoming bookings</h2>
            <Link to="/bookings">All bookings</Link>
          </div>
          {upcoming.length === 0 ? (
            <EmptyState title="No upcoming events">
              <Link className="btn btn--primary" to="/events">
                Browse events
              </Link>
            </EmptyState>
          ) : (
            <ul className="list">
              {upcoming.map((booking) => (
                <li key={booking.bookingId} className="list__item">
                  <div>
                    <Link to={`/bookings/${booking.bookingId}`}>
                      <strong>{booking.eventTitle}</strong>
                    </Link>
                    <div className="muted">
                      {formatDateTime(booking.startAt, booking.timezone)} · {booking.venue} ·{' '}
                      {booking.seatCount} seat(s) ·{' '}
                      {formatMoney(booking.totalAmountMinor, booking.currency)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="recent-heading">
          <div className="card__header">
            <h2 id="recent-heading">
              Notifications{unreadNotifications > 0 ? ` (${unreadNotifications} unread)` : ''}
            </h2>
            <Link to="/notifications">View all</Link>
          </div>
          {recentNotifications.length === 0 ? (
            <p className="muted">No notifications yet.</p>
          ) : (
            <ul className="list">
              {recentNotifications.map((notification) => (
                <NotificationItem key={notification.id} notification={notification} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** Signed-in user's home: profile for everyone, plus the customer dashboard or role shortcuts. */
export function AccountPage({ api = defaultApi }: { api?: DashboardApi }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="dashboard">
      <div className="page-header">
        <h1>{user.role === 'CUSTOMER' ? 'My dashboard' : 'My account'}</h1>
      </div>
      {user.role === 'CUSTOMER' && <CustomerDashboard api={api} />}
      <Profile user={user} />
      {user.role !== 'CUSTOMER' && (
        <p className="list__actions">
          <Link className="btn btn--primary" to="/organizer">
            Organizer dashboard
          </Link>
          {user.role === 'ADMIN' && (
            <Link className="btn btn--secondary" to="/admin">
              Admin console
            </Link>
          )}
          <Link className="btn btn--secondary" to="/notifications">
            Notifications
          </Link>
        </p>
      )}
    </div>
  );
}
