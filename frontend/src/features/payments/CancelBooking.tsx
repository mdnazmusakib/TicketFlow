import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormAlert } from '../../components/ui/Form';
import { toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import {
  bookingsApi as defaultApi,
  type Booking,
  type BookingsApi,
  type CancellationPreview,
} from '../bookings/bookingsApi';

/**
 * Two-step cancellation: show the server's refund decision (full refund only
 * more than 24 hours before the event), then cancel on confirmation.
 */
export function CancelBooking({
  booking,
  onBookingChange,
  api = defaultApi,
}: {
  booking: Booking;
  onBookingChange: (booking: Booking) => void;
  api?: BookingsApi;
}) {
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const cancellable = ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status);
  if (!cancellable && !message) return null;

  async function loadPreview() {
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await api.cancellationPreview(booking.id));
    } catch (error) {
      setMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      const updated = await api.cancel(booking.id);
      onBookingChange(updated);
      setPreview(null);
      const decision = updated.refundDecision;
      setMessage({
        tone: 'success',
        text: decision?.refundable
          ? `Booking cancelled. A refund of ${formatMoney(decision.refundAmountMinor, updated.currency)} (full ticket price) has been requested.`
          : 'Booking cancelled and seats released.',
      });
    } catch (error) {
      setMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const paid = booking.status === 'CONFIRMED';
  return (
    <div className="cancel-booking">
      <FormAlert message={message?.text} tone={message?.tone} />
      {cancellable && !preview && (
        <Button variant="ghost" onClick={loadPreview} disabled={busy}>
          Cancel booking
        </Button>
      )}
      {cancellable && preview && (
        <div className="alert alert--info" role="dialog" aria-label="Confirm cancellation">
          <div>
            {paid ? (
              preview.refundable ? (
                <p>
                  The event is more than 24 hours away, so you will get a{' '}
                  <strong>
                    full refund of the ticket price:{' '}
                    {formatMoney(preview.refundAmountMinor, preview.currency)}
                  </strong>
                  .
                  {(preview.nonRefundable.platformFeeMinor > 0 ||
                    preview.nonRefundable.vatMinor > 0) && (
                    <>
                      {' '}
                      The platform charge (
                      {formatMoney(preview.nonRefundable.platformFeeMinor, preview.currency)}) and
                      VAT ({formatMoney(preview.nonRefundable.vatMinor, preview.currency)}) are not
                      refundable.
                    </>
                  )}
                </p>
              ) : (
                <p>
                  The event starts within 24 hours. Cancelling now gives <strong>no refund</strong>.
                </p>
              )
            ) : (
              <p>Nothing has been charged. Your seats will be released.</p>
            )}
            <div className="form-actions">
              <Button onClick={confirm} disabled={busy}>
                Confirm cancellation
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
                Keep booking
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
