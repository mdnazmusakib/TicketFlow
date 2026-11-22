import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/Feedback';
import { FormAlert } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import {
  bookingsApi as defaultApi,
  STATUS_LABEL,
  type Booking,
  type BookingsApi,
} from './bookingsApi';
import { Countdown } from './Countdown';

const STATUS_TONE: Record<Booking['status'], string> = {
  HELD: 'badge--neutral',
  PENDING_PAYMENT: 'badge--neutral',
  CONFIRMED: 'badge--up',
  EXPIRED: 'badge--down',
  CANCELLED: 'badge--down',
};

export function BookingStatusBadge({ status }: { status: Booking['status'] }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** Booking status, countdown while held, actions and full status history. */
export function BookingDetailPage({ api = defaultApi }: { api?: BookingsApi }) {
  const { id = '' } = useParams();
  const [booking, setBooking] = useState<Booking | null>(null);
  const loaded = useAsync(
    useCallback(async (signal: AbortSignal) => setBooking(await api.get(id, signal)), [api, id]),
    id,
  );
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'info';
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  if (loaded.status === 'loading' && !booking) return <Spinner label="Loading booking" />;
  if (loaded.status === 'error') {
    if (loaded.error instanceof ApiError && loaded.error.status === 404) {
      return (
        <div className="error-state">
          <h1>Booking not found</h1>
          <Link className="btn btn--primary" to="/bookings">
            My bookings
          </Link>
        </div>
      );
    }
    return <ErrorMessage message={toErrorMessage(loaded.error)} onRetry={loaded.reload} />;
  }
  if (!booking) return null;

  async function act(action: 'checkout' | 'cancel') {
    setBusy(true);
    setMessage(null);
    try {
      const updated = action === 'checkout' ? await api.checkout(id) : await api.cancel(id);
      setBooking(updated);
      setMessage(
        action === 'checkout'
          ? {
              tone: 'info',
              text: 'Seats reserved for payment. Online payment opens in the next release.',
            }
          : { tone: 'success', text: 'Booking cancelled and seats released.' },
      );
    } catch (error) {
      setMessage({ tone: 'error', text: toErrorMessage(error) });
      if (
        error instanceof ApiError &&
        (error.code === 'HOLD_EXPIRED' || error.code === 'INVALID_STATE_TRANSITION')
      ) {
        loaded.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const active = booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT';

  return (
    <div className="booking-page">
      <section className="card">
        <div className="page-header">
          <h1>{booking.event.title}</h1>
          <BookingStatusBadge status={booking.status} />
        </div>
        <p className="muted">
          {formatDateTime(booking.event.startAt, booking.event.timezone)} ·{' '}
          {booking.event.venueName}, {booking.event.venueCity}
        </p>
        {active && booking.holdExpiresAt && (
          <Countdown
            expiresAt={booking.holdExpiresAt}
            serverTime={booking.serverTime}
            onExpire={loaded.refresh}
          />
        )}
        {booking.status === 'EXPIRED' && (
          <p className="alert alert--error">
            Your 5-minute hold expired and the seats were released.{' '}
            <Link to={`/events/${booking.eventId}`}>Choose seats again</Link>
          </p>
        )}
        <FormAlert message={message?.text} tone={message?.tone} />

        <table className="table">
          <thead>
            <tr>
              <th scope="col">Seat</th>
              <th scope="col">Category</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody>
            {booking.seats.map((seat) => (
              <tr key={seat.seatId}>
                <td>
                  Row {seat.row}, seat {seat.number}
                </td>
                <td>{seat.category}</td>
                <td>{formatMoney(seat.priceMinor, booking.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="booking-summary__total">
          Total <strong>{formatMoney(booking.totalAmountMinor, booking.currency)}</strong>
          {booking.pricingStrategy === 'EARLY_BIRD' && (
            <span className="badge badge--up"> Early-bird price</span>
          )}
        </p>

        <div className="form-actions">
          {booking.status === 'HELD' && (
            <Button onClick={() => act('checkout')} disabled={busy}>
              Continue to payment
            </Button>
          )}
          {active && (
            <Button variant="ghost" onClick={() => act('cancel')} disabled={busy}>
              Cancel booking
            </Button>
          )}
        </div>
      </section>

      <section className="card">
        <h2>History</h2>
        <ol className="timeline">
          {booking.history.map((entry) => (
            <li key={`${entry.to}-${entry.at}`}>
              <strong>{STATUS_LABEL[entry.to]}</strong>
              <span className="muted">
                {' '}
                · {formatDateTime(entry.at)}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
