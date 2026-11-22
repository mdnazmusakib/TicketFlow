import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage } from '../../components/ui/Feedback';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { eventsApi as defaultApi, type EventsApi } from './eventsApi';
import type { BookingsApi } from '../bookings/bookingsApi';
import { SeatSelection } from '../bookings/SeatSelection';

export function EventDetailPage({
  api = defaultApi,
  bookingsApi,
}: {
  api?: EventsApi;
  bookingsApi?: BookingsApi;
}) {
  const { id = '' } = useParams();
  const details = useAsync(
    useCallback((signal: AbortSignal) => api.details(id, signal), [api, id]),
    id,
  );

  if (details.status === 'loading') return <Spinner label="Loading event" />;
  if (details.status === 'error') {
    if (details.error instanceof ApiError && details.error.status === 404) {
      return (
        <div className="error-state">
          <h1>Event not found</h1>
          <p>This event does not exist or is no longer on sale.</p>
          <Link className="btn btn--primary" to="/events">
            Browse events
          </Link>
        </div>
      );
    }
    return <ErrorMessage message={toErrorMessage(details.error)} onRetry={details.reload} />;
  }

  const event = details.data;
  return (
    <article className="event-detail">
      <header className="card">
        {event.bannerUrl && (
          <img className="event-banner" src={event.bannerUrl} alt="" loading="lazy" />
        )}
        <h1>{event.title}</h1>
        <p className="muted">
          {formatDateTime(event.startAt, event.venue.timezone)}
          {event.endAt && ` – ${formatDateTime(event.endAt, event.venue.timezone)}`}
        </p>
        <p>
          {event.venue.name}, {event.venue.address}, {event.venue.city}
        </p>
        {event.pricing.earlyBirdActive && event.pricing.earlyBirdDeadline && (
          <p className="alert alert--success">
            Early bird: {event.pricing.earlyBirdDiscountPct}% off until{' '}
            {formatDateTime(event.pricing.earlyBirdDeadline, event.venue.timezone)}
          </p>
        )}
        {event.description && <p>{event.description}</p>}
      </header>

      <section className="card">
        <h2>Tickets</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Price</th>
              <th scope="col">Available</th>
            </tr>
          </thead>
          <tbody>
            {event.categories.map((category) => (
              <tr key={category.id}>
                <td>{category.name}</td>
                <td>{formatMoney(category.priceMinor, event.currency)}</td>
                <td>
                  {category.availableSeats} / {category.totalSeats}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Choose your seats</h2>
        <SeatSelection
          eventId={event.id}
          eventsApi={api}
          {...(bookingsApi ? { bookingsApi } : {})}
        />
      </section>
    </article>
  );
}
