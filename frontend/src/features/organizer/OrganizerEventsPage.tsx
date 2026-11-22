import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Pagination, StatusBadge } from '../../components/ui/Feedback';
import { FormAlert } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { organizerApi as defaultApi, type OrganizerApi } from '../events/eventsApi';
import type { ManagedEvent } from '../events/types';
import type { DashboardApi } from '../dashboard/dashboardApi';
import { OrganizerOverview } from './OrganizerOverview';

const DONE = {
  publish: 'published',
  unpublish: 'unpublished',
  cancel: 'cancelled',
  delete: 'deleted',
} as const;

export function OrganizerEventsPage({
  api = defaultApi,
  dashboard,
}: {
  api?: OrganizerApi;
  dashboard?: DashboardApi;
}) {
  const [page, setPage] = useState(1);
  const events = useAsync(
    useCallback(
      (signal: AbortSignal) => api.listEvents({ page, pageSize: 10 }, signal),
      [api, page],
    ),
    String(page),
  );
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function run(event: ManagedEvent, action: 'publish' | 'unpublish' | 'cancel' | 'delete') {
    if (
      (action === 'cancel' || action === 'delete') &&
      !window.confirm(`${action === 'delete' ? 'Delete' : 'Cancel'} "${event.title}"?`)
    ) {
      return;
    }
    setMessage(null);
    try {
      if (action === 'delete') await api.deleteEvent(event.id);
      else await api.transition(event.id, action);
      setMessage({ tone: 'success', text: `Event ${DONE[action]}` });
      events.reload();
    } catch (err) {
      setMessage({ tone: 'error', text: toErrorMessage(err) });
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>Organizer dashboard</h1>
        <div className="list__actions">
          <Link className="btn btn--secondary" to="/organizer/venues">
            Venues
          </Link>
          <Link className="btn btn--primary" to="/organizer/events/new">
            New event
          </Link>
        </div>
      </div>
      <OrganizerOverview {...(dashboard ? { api: dashboard } : {})} />
      <h2>My events</h2>
      <FormAlert message={message?.text} tone={message?.tone} />
      {events.status === 'loading' && <Spinner label="Loading your events" />}
      {events.status === 'error' && (
        <ErrorMessage message={toErrorMessage(events.error)} onRetry={events.reload} />
      )}
      {events.status === 'success' && events.data.items.length === 0 && (
        <EmptyState title="No events yet">
          <p>Create a venue, then your first event.</p>
        </EmptyState>
      )}
      {events.status === 'success' && events.data.items.length > 0 && (
        <>
          <ul className="list card">
            {events.data.items.map((event) => (
              <li key={event.id} className="list__item">
                <div>
                  <strong>{event.title}</strong> <StatusBadge status={event.status} />
                  <div className="muted">
                    {formatDateTime(event.startAt, event.venue.timezone)} · {event.venue.name} ·{' '}
                    {event.availableSeats ?? 0}/{event.totalSeats ?? 0} seats free
                  </div>
                </div>
                <div className="list__actions">
                  {(event.status === 'DRAFT' || event.status === 'PUBLISHED') && (
                    <>
                      <Link
                        className="btn btn--secondary"
                        to={`/organizer/events/${event.id}/edit`}
                      >
                        Edit
                      </Link>
                      <Link
                        className="btn btn--secondary"
                        to={`/organizer/events/${event.id}/seats`}
                      >
                        Seat map
                      </Link>
                    </>
                  )}
                  <Link
                    className="btn btn--secondary"
                    to={`/organizer/events/${event.id}/bookings`}
                  >
                    Bookings
                  </Link>
                  {event.status === 'DRAFT' && (
                    <Button onClick={() => run(event, 'publish')}>Publish</Button>
                  )}
                  {event.status === 'PUBLISHED' && (
                    <Button variant="secondary" onClick={() => run(event, 'unpublish')}>
                      Unpublish
                    </Button>
                  )}
                  {(event.status === 'DRAFT' || event.status === 'PUBLISHED') && (
                    <Button variant="ghost" onClick={() => run(event, 'cancel')}>
                      Cancel
                    </Button>
                  )}
                  {(event.status === 'DRAFT' || event.status === 'CANCELLED') && (
                    <Button variant="ghost" onClick={() => run(event, 'delete')}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            page={events.data.meta.page}
            totalPages={events.data.meta.totalPages}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}
