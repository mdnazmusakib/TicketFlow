import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormAlert } from '../../components/ui/Form';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  bookingsApi as defaultApi,
  type Booking,
  type BookingsApi,
  type Refund,
} from '../bookings/bookingsApi';

const LABEL: Record<Refund['status'], string> = {
  PENDING: 'Refund requested',
  PROCESSING: 'Refund processing',
  SUCCEEDED: 'Refunded',
  FAILED: 'Refund failed',
};

const TONE: Record<Refund['status'], string> = {
  PENDING: 'badge--neutral',
  PROCESSING: 'badge--neutral',
  SUCCEEDED: 'badge--up',
  FAILED: 'badge--down',
};

/** Refund attempts for a booking, with a retry button for failed ones. */
export function RefundStatus({
  booking,
  onBookingChange,
  api = defaultApi,
}: {
  booking: Booking;
  onBookingChange: (booking: Booking) => void;
  api?: BookingsApi;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refunds = booking.refunds ?? [];
  if (refunds.length === 0) {
    return booking.status === 'CANCELLED' && booking.refundAmountMinor === 0 ? (
      <p className="muted">No refund applies to this cancellation.</p>
    ) : null;
  }
  const latest = refunds.at(-1)!;

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      onBookingChange(await api.retryRefund(booking.id));
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="refund-title">
      <h2 id="refund-title">Refund</h2>
      <p>
        <span className={`badge ${TONE[latest.status]}`}>{LABEL[latest.status]}</span>{' '}
        {formatMoney(latest.amountMinor, latest.currency)}
      </p>
      {latest.status === 'FAILED' && (
        <>
          <p className="muted">
            {latest.failureReason ?? 'The provider could not process the refund.'}
            {latest.nextRetryAt
              ? ` We will retry automatically after ${formatDateTime(latest.nextRetryAt)}.`
              : ''}
          </p>
          <Button variant="secondary" onClick={retry} disabled={busy}>
            Retry refund now
          </Button>
        </>
      )}
      {latest.status === 'PROCESSING' && (
        <p className="muted">Your bank may take a few days to show the money.</p>
      )}
      <FormAlert message={error} />
      {refunds.length > 1 && (
        <ol className="timeline">
          {refunds.map((refund) => (
            <li key={refund.id}>
              Attempt {refund.attempt}: {LABEL[refund.status]}
              {refund.failureReason ? ` · ${refund.failureReason}` : ''}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
