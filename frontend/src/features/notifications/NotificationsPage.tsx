import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Pagination } from '../../components/ui/Feedback';
import { FormAlert } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import {
  announceNotificationsChanged,
  notificationsApi as defaultApi,
  NOTIFICATION_LABEL,
  type InAppNotification,
  type NotificationsApi,
} from './notificationsApi';

export function NotificationItem({
  notification,
  onMarkRead,
}: {
  notification: InAppNotification;
  onMarkRead?: (id: string) => void;
}) {
  return (
    <li className={`notification ${notification.isRead ? '' : 'notification--unread'}`}>
      <div className="notification__head">
        <strong>
          {notification.title}
          {!notification.isRead && <span className="visually-hidden"> (unread)</span>}
        </strong>
        <span className="muted">
          {NOTIFICATION_LABEL[notification.type] ?? notification.type} ·{' '}
          <time dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time>
        </span>
      </div>
      <p className="notification__message">{notification.message}</p>
      <div className="list__actions">
        {notification.bookingId && (
          <Link to={`/bookings/${notification.bookingId}`}>View booking</Link>
        )}
        {onMarkRead && !notification.isRead && (
          <Button variant="ghost" onClick={() => onMarkRead(notification.id)}>
            Mark as read
          </Button>
        )}
      </div>
    </li>
  );
}

/** The signed-in user's in-app inbox: filter, paginate, mark one / all read. */
export function NotificationsPage({ api = defaultApi }: { api?: NotificationsApi }) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const inbox = useAsync(
    useCallback(
      (signal: AbortSignal) => api.list({ unreadOnly, page, pageSize: 10 }, signal),
      [api, unreadOnly, page],
    ),
    `${unreadOnly}:${page}`,
  );

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      announceNotificationsChanged();
      inbox.refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  const unreadCount = inbox.status === 'success' ? inbox.data.meta.unreadCount : 0;

  return (
    <section>
      <div className="page-header">
        <h1>Notifications</h1>
        <div className="list__actions">
          <div className="chips" role="group" aria-label="Filter notifications">
            {[
              { value: false, label: 'All' },
              { value: true, label: 'Unread' },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                className={`chip ${unreadOnly === option.value ? 'chip--on' : ''}`}
                aria-pressed={unreadOnly === option.value}
                onClick={() => {
                  setUnreadOnly(option.value);
                  setPage(1);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            disabled={unreadCount === 0}
            onClick={() => act(() => api.markAllRead())}
          >
            Mark all as read
          </Button>
        </div>
      </div>
      <FormAlert message={error ?? undefined} tone="error" />
      {inbox.status === 'loading' && <Spinner label="Loading notifications" />}
      {inbox.status === 'error' && (
        <ErrorMessage message={toErrorMessage(inbox.error)} onRetry={inbox.reload} />
      )}
      {inbox.status === 'success' && (
        <>
          <p className="muted" aria-live="polite">
            {unreadCount === 0 ? 'You are all caught up.' : `${unreadCount} unread`}
          </p>
          {inbox.data.items.length === 0 ? (
            <EmptyState title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}>
              <p>Booking confirmations, cancellations and event reminders appear here.</p>
            </EmptyState>
          ) : (
            <ul className="list card">
              {inbox.data.items.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onMarkRead={(id) => act(() => api.markRead(id))}
                />
              ))}
            </ul>
          )}
          <Pagination
            page={inbox.data.meta.page}
            totalPages={inbox.data.meta.totalPages}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}
