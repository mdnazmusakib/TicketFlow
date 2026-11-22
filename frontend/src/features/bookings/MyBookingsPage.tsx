import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorMessage, Pagination } from '../../components/ui/Feedback';
import { SelectField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { BookingStatusBadge } from './BookingDetailPage';
import {
  bookingsApi as defaultApi,
  STATUS_LABEL,
  type BookingStatus,
  type BookingsApi,
} from './bookingsApi';

export function MyBookingsPage({ api = defaultApi }: { api?: BookingsApi }) {
  const [status, setStatus] = useState<BookingStatus | ''>('');
  const [page, setPage] = useState(1);
  const bookings = useAsync(
    useCallback(
      (signal: AbortSignal) =>
        api.list({ status: status || undefined, page, pageSize: 10 }, signal),
      [api, status, page],
    ),
    `${status}:${page}`,
  );

  return (
    <section>
      <div className="page-header">
        <h1>My bookings</h1>
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as BookingStatus | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'All' },
            ...(Object.keys(STATUS_LABEL) as BookingStatus[]).map((value) => ({
              value,
              label: STATUS_LABEL[value],
            })),
          ]}
        />
      </div>
      {bookings.status === 'loading' && <Spinner label="Loading bookings" />}
      {bookings.status === 'error' && (
        <ErrorMessage message={toErrorMessage(bookings.error)} onRetry={bookings.reload} />
      )}
      {bookings.status === 'success' && bookings.data.items.length === 0 && (
        <EmptyState title="No bookings yet">
          <Link className="btn btn--primary" to="/events">
            Browse events
          </Link>
        </EmptyState>
      )}
      {bookings.status === 'success' && bookings.data.items.length > 0 && (
        <>
          <ul className="list card">
            {bookings.data.items.map((booking) => (
              <li key={booking.id} className="list__item">
                <div>
                  <Link to={`/bookings/${booking.id}`}>
                    <strong>{booking.event.title}</strong>
                  </Link>{' '}
                  <BookingStatusBadge status={booking.status} />
                  <div className="muted">
                    {formatDateTime(booking.event.startAt, booking.event.timezone)} ·{' '}
                    {booking.seatCount} seat(s) ·{' '}
                    {formatMoney(booking.totalAmountMinor, booking.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            page={bookings.data.meta.page}
            totalPages={bookings.data.meta.totalPages}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}
