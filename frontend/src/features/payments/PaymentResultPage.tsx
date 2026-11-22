import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import {
  bookingsApi as defaultApi,
  type BookingsApi,
  type PaymentResult,
} from '../bookings/bookingsApi';

const MAX_POLLS = 20;

/**
 * Landing page after a hosted checkout (Mock A or SSLCommerz). The browser
 * redirect only brings the customer here; the status shown is what the server
 * verified with the provider, polled until it is final.
 */
export function PaymentResultPage({
  api = defaultApi,
  pollMs = 2000,
}: {
  api?: BookingsApi;
  pollMs?: number;
}) {
  const { id = '' } = useParams();
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (id === 'unknown') return;
    let cancelled = false;
    let count = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api.paymentStatus(id);
        if (cancelled) return;
        setResult(next);
        count += 1;
        setPolls(count);
        const open = next.payment.status === 'PENDING' || next.payment.status === 'INITIATED';
        if (open && count < MAX_POLLS) timer = setTimeout(load, pollMs);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof ApiError && err.status === 404
              ? 'Payment not found.'
              : toErrorMessage(err),
          );
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, id, pollMs]);

  if (id === 'unknown') {
    return (
      <div className="error-state">
        <h1>We could not identify this payment</h1>
        <p>If money was taken, it will be matched or refunded automatically.</p>
        <Link className="btn btn--primary" to="/bookings">
          My bookings
        </Link>
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-state" role="alert">
        <h1>Payment status unavailable</h1>
        <p>{error}</p>
      </div>
    );
  }
  if (!result) return <Spinner label="Checking your payment" />;

  const { payment, booking } = result;
  const bookingLink = (
    <Link className="btn btn--primary" to={`/bookings/${booking.id}`}>
      View booking
    </Link>
  );

  if (payment.status === 'SUCCEEDED' && booking.status === 'CONFIRMED') {
    return (
      <section className="card payment-result payment-result--success">
        <h1>Payment successful</h1>
        <p>
          {formatMoney(payment.amountMinor, payment.currency)} paid. Your booking for{' '}
          <strong>{booking.event.title}</strong> is confirmed.
        </p>
        {bookingLink}
      </section>
    );
  }
  if (payment.status === 'SUCCEEDED') {
    return (
      <section className="card payment-result">
        <h1>Payment received, booking not confirmed</h1>
        <p>
          Your seat hold ended before the payment arrived, so the full amount is being refunded.
        </p>
        {bookingLink}
      </section>
    );
  }
  if (payment.status === 'FAILED' || payment.status === 'CANCELLED') {
    return (
      <section className="card payment-result payment-result--failed" role="alert">
        <h1>Payment {payment.status === 'FAILED' ? 'failed' : 'cancelled'}</h1>
        <p>
          {payment.failureReason ?? 'The payment was not completed.'} Your seats stay held until the
          hold expires.
        </p>
        {bookingLink}
      </section>
    );
  }
  return (
    <section className="card payment-result" role="status">
      <h1>Payment pending</h1>
      <p>
        We are waiting for the provider to confirm your payment
        {polls >= MAX_POLLS ? '. This can take a few minutes — check your booking later.' : '…'}
      </p>
      {polls >= MAX_POLLS ? bookingLink : <Spinner label="Still checking" />}
    </section>
  );
}
