import { useCallback, useEffect, useMemo, useState } from 'react';
import { PriceBreakdown } from './PriceBreakdown';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { FormAlert } from '../../components/ui/Form';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { useAuth } from '../auth/AuthContext';
import { eventsApi as defaultEventsApi, type EventsApi } from '../events/eventsApi';
import { SeatGrid } from '../events/SeatGrid';
import type { Seat } from '../events/types';
import { bookingsApi as defaultBookingsApi, type BookingsApi, type Quote } from './bookingsApi';

export const MAX_TICKETS = 6;
const REFRESH_MS = 10_000;

interface Props {
  eventId: string;
  eventsApi?: EventsApi;
  bookingsApi?: BookingsApi;
  refreshMs?: number;
}

function newIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Seat picking with live availability (polled), a server-priced summary and a
 * 5-minute hold. Availability shown here is advisory: the server re-checks
 * everything inside the hold transaction.
 */
export function SeatSelection({
  eventId,
  eventsApi = defaultEventsApi,
  bookingsApi = defaultBookingsApi,
  refreshMs = REFRESH_MS,
}: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const availability = useAsync(
    useCallback(
      (signal: AbortSignal) => eventsApi.availability(eventId, signal),
      [eventsApi, eventId],
    ),
    eventId,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quote, setQuote] = useState<Quote | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [holding, setHolding] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  // Live availability: refresh periodically while the page is open.
  const { refresh } = availability;
  useEffect(() => {
    const timer = setInterval(refresh, refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);

  const seats = useMemo(
    () => (availability.status === 'success' ? availability.data.seats : []),
    [availability],
  );

  // Drop selected seats that became unavailable since they were picked.
  const effectiveSelection = useMemo(() => {
    const unavailable = new Set(
      seats.filter((seat) => seat.status === 'UNAVAILABLE').map((seat) => seat.id),
    );
    return new Set([...selected].filter((id) => !unavailable.has(id)));
  }, [seats, selected]);
  const selectionKey = [...effectiveSelection].sort().join(',');

  useEffect(() => {
    if (!user || user.role !== 'CUSTOMER' || selectionKey === '') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      bookingsApi
        .quote(eventId, selectionKey.split(','), controller.signal)
        .then(setQuote, (error: unknown) => {
          if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) setQuote(null);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bookingsApi, eventId, selectionKey, user]);

  if (availability.status === 'loading' && seats.length === 0)
    return <p className="muted">Loading seats…</p>;
  if (availability.status === 'error')
    return <FormAlert message={toErrorMessage(availability.error)} />;
  if (availability.status !== 'success') return null;

  const canBook = user?.role === 'CUSTOMER';

  function toggle(seat: Seat) {
    setMessage(null);
    setSelected((current) => {
      const next = new Set([...current].filter((id) => effectiveSelection.has(id)));
      if (next.has(seat.id)) next.delete(seat.id);
      else if (next.size >= MAX_TICKETS) {
        setMessage({ tone: 'info', text: `You can select up to ${MAX_TICKETS} seats per event.` });
      } else next.add(seat.id);
      return next;
    });
  }

  async function hold() {
    setHolding(true);
    setMessage(null);
    try {
      const booking = await bookingsApi.hold(eventId, [...effectiveSelection], idempotencyKey);
      navigate(`/bookings/${booking.id}`);
    } catch (error) {
      setIdempotencyKey(newIdempotencyKey());
      if (error instanceof ApiError && error.code === 'SEATS_UNAVAILABLE') {
        const taken = new Set(error.details.map((detail) => detail.message));
        setSelected((current) => new Set([...current].filter((id) => !taken.has(id))));
        refresh();
      }
      setMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setHolding(false);
    }
  }

  const showQuote = canBook && effectiveSelection.size > 0 && quote !== null;

  return (
    <div className="seat-selection">
      <SeatGrid
        seats={seats}
        categories={availability.data.categories}
        selected={effectiveSelection}
        onToggle={canBook ? toggle : undefined}
      />
      <FormAlert message={message?.text} tone={message?.tone} />
      {!user && (
        <p>
          <Link to={`/login?next=${encodeURIComponent(`/events/${eventId}`)}`}>
            Sign in as a customer
          </Link>{' '}
          to choose seats.
        </p>
      )}
      {user && !canBook && <p className="muted">Bookings are made with a customer account.</p>}
      {canBook && (
        <aside className="booking-summary" aria-label="Booking summary">
          <h3>Your selection</h3>
          {effectiveSelection.size === 0 && (
            <p className="muted">Pick up to {MAX_TICKETS} available seats.</p>
          )}
          {showQuote && (
            <>
              <ul className="list">
                {quote.lines.map((line) => (
                  <li key={line.seatId} className="list__item">
                    <span>
                      Row {line.row} · Seat {line.number} · {line.category}
                    </span>
                    <span>
                      {line.discountMinor > 0 && (
                        <s className="muted">{formatMoney(line.basePriceMinor, quote.currency)} </s>
                      )}
                      {formatMoney(line.unitPriceMinor, quote.currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <PriceBreakdown
                value={{
                  currency: quote.currency,
                  seatCount: quote.lines.length,
                  ticketSubtotalMinor: quote.ticketTotalMinor,
                  discountMinor: quote.discountMinor,
                  platformFeePerSeatMinor: quote.platformFeePerSeatMinor,
                  platformFeeMinor: quote.platformFeeMinor,
                  vatRateBps: quote.vatRateBps,
                  vatMinor: quote.vatMinor,
                  grandTotalMinor: quote.totalMinor,
                }}
              />
            </>
          )}
          <Button disabled={effectiveSelection.size === 0 || holding} onClick={hold}>
            {holding
              ? 'Holding seats…'
              : `Hold ${effectiveSelection.size || ''} seat(s) for 5 minutes`}
          </Button>
        </aside>
      )}
    </div>
  );
}
