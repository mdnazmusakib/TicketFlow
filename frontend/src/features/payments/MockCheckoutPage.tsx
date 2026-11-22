import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/Feedback';
import { FormAlert } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { bookingsApi as defaultApi, type BookingsApi } from '../bookings/bookingsApi';

/**
 * Simulated hosted checkout page of Mock Provider A (stands in for a card
 * gateway page). Completing it makes the mock provider send a signed webhook
 * to the API; the booking is confirmed only after that server-side path.
 */
export function MockCheckoutPage({ api = defaultApi }: { api?: BookingsApi }) {
  const [params] = useSearchParams();
  const ref = params.get('ref') ?? '';
  const navigate = useNavigate();
  const loaded = useAsync(
    useCallback((signal: AbortSignal) => api.mockCheckout(ref, signal), [api, ref]),
    ref,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ref) return <ErrorMessage message="Missing payment reference." />;
  if (loaded.status === 'loading') return <Spinner label="Opening checkout" />;
  if (loaded.status === 'error') return <ErrorMessage message={toErrorMessage(loaded.error)} />;
  const { payment, booking } = loaded.data;

  async function complete(outcome: 'success' | 'failure') {
    setBusy(true);
    setError(null);
    try {
      const result = await api.mockComplete(ref, outcome);
      navigate(`/payments/${result.payment.id}/result`, { replace: true });
    } catch (err) {
      setError(toErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card mock-checkout">
      <p className="badge badge--neutral">Mock Provider A · test mode</p>
      <h1>Pay {formatMoney(payment.amountMinor, payment.currency)}</h1>
      <p className="muted">
        {booking.event.title} · reference {payment.transactionRef}
      </p>
      <FormAlert message={error} />
      {payment.status === 'PENDING' ? (
        <div className="form-actions">
          <Button onClick={() => complete('success')} disabled={busy}>
            Pay now
          </Button>
          <Button variant="ghost" onClick={() => complete('failure')} disabled={busy}>
            Decline payment
          </Button>
        </div>
      ) : (
        <Button onClick={() => navigate(`/payments/${payment.id}/result`)}>
          View payment result
        </Button>
      )}
    </section>
  );
}
