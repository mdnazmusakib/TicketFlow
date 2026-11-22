import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormAlert, SelectField } from '../../components/ui/Form';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import {
  bookingsApi as defaultApi,
  newIdempotencyKey,
  PROVIDER_LABEL,
  TOKEN_LABEL,
  type Booking,
  type BookingsApi,
  type Payment,
  type PaymentProvider,
} from '../bookings/bookingsApi';

interface Props {
  booking: Booking;
  onBookingChange: (booking: Booking) => void;
  api?: BookingsApi;
  /** Full-page navigation to a provider's hosted page (overridable in tests). */
  redirect?: (url: string) => void;
  pollMs?: number;
}

const defaultRedirect = (url: string) => window.location.assign(url);

/**
 * Payment step of a held booking. The server decides the amount and the final
 * status; this component only starts attempts and shows what the server says.
 */
export function PaymentPanel({
  booking,
  onBookingChange,
  api = defaultApi,
  redirect = defaultRedirect,
  pollMs = 3000,
}: Props) {
  const options = useAsync(useCallback((signal: AbortSignal) => api.providers(signal), [api]));
  const [provider, setProvider] = useState<PaymentProvider | ''>('');
  const [token, setToken] = useState('tok_success');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  // One key per intended payment: retries of the same click reuse it, a new attempt gets a new one.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const openPayment: Payment | undefined = booking.payments?.find(
    (p) => p.status === 'PENDING' || p.status === 'INITIATED',
  );
  const selected = provider || options.data?.providers[0] || '';

  // Poll an open attempt (e.g. direct charge awaiting confirmation) until it resolves.
  useEffect(() => {
    if (!openPayment || openPayment.redirectUrl) return;
    const timer = setInterval(() => {
      api.paymentStatus(openPayment.id).then(
        (result) => {
          if (result.payment.status !== 'PENDING' && result.payment.status !== 'INITIATED')
            onBookingChange(result.booking);
        },
        () => undefined,
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [api, openPayment, onBookingChange, pollMs]);

  async function startPayment() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.pay(
        booking.id,
        selected,
        idempotencyKey,
        selected === 'MOCK_PROVIDER_B' ? token : undefined,
      );
      onBookingChange(result.booking);
      if (result.payment.redirectUrl) {
        redirect(result.payment.redirectUrl);
        return;
      }
      if (result.payment.status === 'FAILED') {
        setIdempotencyKey(newIdempotencyKey());
        setMessage({
          tone: 'error',
          text: `Payment failed: ${result.payment.failureReason ?? 'declined'}. You can try again.`,
        });
      } else if (result.payment.status === 'PENDING') {
        setMessage({ tone: 'info', text: 'Payment is being confirmed by the provider…' });
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'IDEMPOTENCY_IN_PROGRESS'))
        setIdempotencyKey(newIdempotencyKey());
      setMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function cancelAttempt(payment: Payment) {
    setBusy(true);
    try {
      const result = await api.cancelPayment(payment.id);
      onBookingChange(result.booking);
      setIdempotencyKey(newIdempotencyKey());
      setMessage(
        result.payment.status === 'SUCCEEDED'
          ? {
              tone: 'info',
              text: 'That payment had already gone through — your booking is confirmed.',
            }
          : { tone: 'info', text: 'Payment attempt cancelled. Choose another method.' },
      );
    } catch (error) {
      setMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card payment-panel" aria-labelledby="payment-title">
      <h2 id="payment-title">Payment</h2>
      <p>
        Amount due: <strong>{formatMoney(booking.totalAmountMinor, booking.currency)}</strong>
      </p>
      <FormAlert message={message?.text} tone={message?.tone} />

      {openPayment ? (
        <div className="payment-panel__open">
          <p role="status">
            {openPayment.redirectUrl
              ? `You started paying with ${PROVIDER_LABEL[openPayment.provider]}.`
              : 'Waiting for the provider to confirm your payment…'}
          </p>
          <div className="form-actions">
            {openPayment.redirectUrl && (
              <Button onClick={() => redirect(openPayment.redirectUrl!)} disabled={busy}>
                Continue payment
              </Button>
            )}
            <Button variant="ghost" onClick={() => cancelAttempt(openPayment)} disabled={busy}>
              Use another method
            </Button>
          </div>
        </div>
      ) : (
        <>
          {options.status === 'loading' && <p className="muted">Loading payment methods…</p>}
          {options.status === 'error' && <FormAlert message={toErrorMessage(options.error)} />}
          {options.status === 'success' && options.data.providers.length === 0 && (
            <p className="muted">No payment method is configured.</p>
          )}
          {options.status === 'success' && options.data.providers.length > 0 && (
            <>
              <fieldset className="payment-methods">
                <legend>Choose a payment method</legend>
                {options.data.providers.map((name) => (
                  <label key={name} className="payment-method">
                    <input
                      type="radio"
                      name="provider"
                      value={name}
                      checked={selected === name}
                      onChange={() => {
                        setProvider(name);
                        setIdempotencyKey(newIdempotencyKey());
                      }}
                    />
                    {PROVIDER_LABEL[name]}
                  </label>
                ))}
              </fieldset>
              {selected === 'MOCK_PROVIDER_B' && (
                <SelectField
                  label="Test card"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setIdempotencyKey(newIdempotencyKey());
                  }}
                  options={options.data.mockProviderBTokens.map((value) => ({
                    value,
                    label: TOKEN_LABEL[value] ?? value,
                  }))}
                />
              )}
              <Button onClick={startPayment} disabled={busy || !selected}>
                {busy
                  ? 'Processing…'
                  : `Pay ${formatMoney(booking.totalAmountMinor, booking.currency)}`}
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
