import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ErrorMessage, StatusBadge } from '../../components/ui/Feedback';
import { FormAlert, SelectField, TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatMoney, toMajorInput, toMinorUnits } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { organizerApi as defaultApi, type OrganizerApi } from '../events/eventsApi';
import { SeatGrid } from '../events/SeatGrid';
import type { ManagedEventDetails, Seat } from '../events/types';
import { buildSeatMap, SeatMapBuilder, type SeatMapDraft } from './SeatMapBuilder';

function draftFrom(event: ManagedEventDetails): SeatMapDraft {
  const rowsByCategory = new Map<string, Set<string>>();
  for (const seat of event.seats) {
    rowsByCategory.set(
      seat.categoryId,
      (rowsByCategory.get(seat.categoryId) ?? new Set()).add(seat.row),
    );
  }
  return {
    rows: String(event.seatMap.rows),
    seatsPerRow: String(event.seatMap.seatsPerRow),
    categories: event.categories.map((category) => ({
      name: category.name,
      price: toMajorInput(category.priceMinor),
      rows: [...(rowsByCategory.get(category.id) ?? [])],
    })),
  };
}

/** Organizer seat map management: categories, per-seat assignment, full regeneration. */
export function SeatMapPage({ api = defaultApi }: { api?: OrganizerApi }) {
  const { id = '' } = useParams();
  const [event, setEvent] = useState<ManagedEventDetails | null>(null);
  const loaded = useAsync(
    useCallback(async (signal: AbortSignal) => setEvent(await api.getEvent(id, signal)), [api, id]),
    id,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetCategory, setTargetCategory] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [rebuild, setRebuild] = useState<SeatMapDraft | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  if (loaded.status === 'loading' && !event) return <Spinner label="Loading seat map" />;
  if (loaded.status === 'error')
    return <ErrorMessage message={toErrorMessage(loaded.error)} onRetry={loaded.reload} />;
  if (!event) return null;

  async function act(work: () => Promise<ManagedEventDetails>, success: string) {
    setMessage(null);
    try {
      setEvent(await work());
      setMessage({ tone: 'success', text: success });
      return true;
    } catch (err) {
      setMessage({ tone: 'error', text: toErrorMessage(err) });
      return false;
    }
  }

  const toggle = (seat: Seat) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(seat.id)) next.delete(seat.id);
      else next.add(seat.id);
      return next;
    });

  return (
    <div className="seat-map-page">
      <div className="page-header">
        <h1>
          {event.title} <StatusBadge status={event.status} />
        </h1>
        <Link className="btn btn--secondary" to="/organizer">
          Back to events
        </Link>
      </div>
      <FormAlert message={message?.text} tone={message?.tone} />

      <section className="card">
        <h2>Categories &amp; prices</h2>
        <ul className="list">
          {event.categories.map((category) => (
            <li key={category.id} className="list__item">
              <div>
                <strong>{category.name}</strong> ·{' '}
                {formatMoney(category.priceMinor, event.currency)} · {category.availableSeats}/
                {category.totalSeats} free
              </div>
              <div className="list__actions">
                <TextField
                  label={`New price for ${category.name}`}
                  inputMode="decimal"
                  value={prices[category.id] ?? ''}
                  placeholder={toMajorInput(category.priceMinor)}
                  onChange={(e) => setPrices({ ...prices, [category.id]: e.target.value })}
                />
                <Button
                  variant="secondary"
                  disabled={Number.isNaN(toMinorUnits(prices[category.id] ?? ''))}
                  onClick={() =>
                    act(
                      () =>
                        api.updateCategory(event.id, category.id, {
                          priceMinor: toMinorUnits(prices[category.id] ?? ''),
                        }),
                      'Price updated',
                    )
                  }
                >
                  Update price
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <p className="field__hint">
          Price changes apply to new bookings; existing bookings keep the price they paid.
        </p>
      </section>

      <section className="card">
        <h2>Seats</h2>
        <p className="muted">
          Select seats to move them to another category. Held or sold seats cannot be moved.
        </p>
        <SeatGrid
          seats={event.seats}
          categories={event.categories}
          selected={selected}
          onToggle={toggle}
          editable
        />
        <div className="form-row">
          <SelectField
            label="Move selected seats to"
            value={targetCategory}
            onChange={(e) => setTargetCategory(e.target.value)}
            options={[
              { value: '', label: 'Choose a category' },
              ...event.categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <Button
            disabled={selected.size === 0 || !targetCategory}
            onClick={async () => {
              if (
                await act(
                  () => api.assignSeats(event.id, [...selected], targetCategory),
                  `${selected.size} seat(s) reassigned`,
                )
              ) {
                setSelected(new Set());
              }
            }}
          >
            Apply to {selected.size} seat(s)
          </Button>
        </div>
      </section>

      <section className="card">
        <h2>Rebuild seat map</h2>
        <p className="muted">
          Regenerates every seat. Only possible before any booking has been made.
        </p>
        {rebuild ? (
          <>
            <SeatMapBuilder draft={rebuild} onChange={setRebuild} />
            <div className="form-actions">
              <Button
                onClick={async () => {
                  const built = buildSeatMap(rebuild);
                  if (!built.value) {
                    setMessage({ tone: 'error', text: built.errors[0] ?? 'Seat map is invalid' });
                    return;
                  }
                  if (
                    await act(() => api.replaceSeatMap(event.id, built.value!), 'Seat map rebuilt')
                  )
                    setRebuild(null);
                }}
              >
                Save new seat map
              </Button>
              <Button variant="ghost" onClick={() => setRebuild(null)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setRebuild(draftFrom(event))}>
            Edit layout
          </Button>
        )}
      </section>
    </div>
  );
}
