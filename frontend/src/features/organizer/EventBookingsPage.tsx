import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Pagination, StatusBadge } from '../../components/ui/Feedback';
import { SelectField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { StatGrid, StatusCounts } from '../../components/ui/Stats';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { BookingStatusBadge } from '../bookings/BookingDetailPage';
import { STATUS_LABEL, type BookingStatus } from '../bookings/bookingsApi';
import { dashboardApi as defaultApi, type DashboardApi } from '../dashboard/dashboardApi';
import { Occupancy, pricingLabel } from './OrganizerOverview';

/** One event's sales, pricing, category breakdown and attendee bookings (organizer/admin). */
export function EventBookingsPage({ api = defaultApi }: { api?: DashboardApi }) {
  const { id = '' } = useParams();
  const [status, setStatus] = useState<BookingStatus | ''>('');
  const [page, setPage] = useState(1);
  const overview = useAsync(
    useCallback(
      (signal: AbortSignal) =>
        api.eventOverview(id, { status: status || undefined, page, pageSize: 20 }, signal),
      [api, id, status, page],
    ),
    `${id}:${status}:${page}`,
  );

  return (
    <section className="dashboard">
      <p>
        <Link to="/organizer">← Back to my events</Link>
      </p>
      {overview.status === 'loading' && <Spinner label="Loading event bookings" />}
      {overview.status === 'error' && (
        <ErrorMessage message={toErrorMessage(overview.error)} onRetry={overview.reload} />
      )}
      {overview.status === 'success' && (
        <>
          <div className="page-header">
            <h1>
              {overview.data.event.title} <StatusBadge status={overview.data.event.status} />
            </h1>
            <Link className="btn btn--secondary" to={`/organizer/events/${id}/seats`}>
              Seat map
            </Link>
          </div>
          <p className="muted">
            {formatDateTime(overview.data.event.startAt)} ·{' '}
            {pricingLabel(overview.data.event.pricing)}
          </p>
          <StatGrid
            label="Event sales"
            stats={[
              {
                label: 'Seats sold',
                value: <Occupancy event={overview.data.event} />,
              },
              {
                label: 'Available',
                value: overview.data.event.availableSeats,
                hint: `${overview.data.event.heldSeats} on hold`,
              },
              {
                label: 'Gross revenue',
                value: formatMoney(
                  overview.data.event.grossRevenueMinor,
                  overview.data.event.currency,
                ),
              },
              {
                label: 'Net revenue',
                value: formatMoney(
                  overview.data.event.netRevenueMinor,
                  overview.data.event.currency,
                ),
                hint: `${formatMoney(overview.data.event.refundedMinor, overview.data.event.currency)} refunded`,
              },
            ]}
          />
          <div className="dashboard__columns">
            <div className="card">
              <h2>Categories</h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col">Price</th>
                      <th scope="col">Sold</th>
                      <th scope="col">Held</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.categories.map((category) => (
                      <tr key={category.categoryId}>
                        <td>{category.name}</td>
                        <td>{formatMoney(category.priceMinor, overview.data.event.currency)}</td>
                        <td>{category.soldSeats}</td>
                        <td>{category.heldSeats}</td>
                        <td>{category.totalSeats}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h2>Bookings by status</h2>
              <StatusCounts counts={overview.data.bookingsByStatus} label="Bookings by status" />
            </div>
          </div>
          <div className="card">
            <div className="card__header">
              <h2>Bookings</h2>
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
            {overview.data.bookings.length === 0 ? (
              <p className="muted">No bookings match.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col">Seats</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Payment</th>
                      <th scope="col">Booked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.bookings.map((booking) => (
                      <tr key={booking.bookingId}>
                        <td>
                          {booking.customerName}
                          <div className="muted">{booking.customerEmail}</div>
                        </td>
                        <td>
                          <BookingStatusBadge status={booking.status} />
                        </td>
                        <td>{booking.seatCount}</td>
                        <td>
                          {formatMoney(booking.totalAmountMinor, booking.currency)}
                          {booking.refundAmountMinor > 0 && (
                            <div className="muted">
                              Refunded {formatMoney(booking.refundAmountMinor, booking.currency)}
                            </div>
                          )}
                        </td>
                        <td>{booking.paymentProvider ?? '—'}</td>
                        <td>{formatDateTime(booking.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={overview.data.meta.page}
              totalPages={overview.data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        </>
      )}
    </section>
  );
}
