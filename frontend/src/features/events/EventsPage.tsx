import { useCallback, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Pagination } from '../../components/ui/Feedback';
import { SelectField, TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { eventsApi as defaultApi, type EventSearchParams, type EventsApi } from './eventsApi';

const SORTS = [
  { value: 'date:asc', label: 'Soonest first' },
  { value: 'date:desc', label: 'Latest first' },
  { value: 'price:asc', label: 'Price: low to high' },
  { value: 'price:desc', label: 'Price: high to low' },
  { value: 'title:asc', label: 'Name A–Z' },
  { value: 'newest:desc', label: 'Recently added' },
];

function readParams(params: URLSearchParams): EventSearchParams {
  const [sort, order] = (params.get('sort') ?? 'date:asc').split(':') as [
    EventSearchParams['sort'],
    EventSearchParams['order'],
  ];
  return {
    q: params.get('q') ?? undefined,
    city: params.get('city') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    sort,
    order,
    page: Number(params.get('page') ?? '1') || 1,
    pageSize: 12,
  };
}

/** Public catalogue; filters live in the URL so results are shareable and survive refresh. */
export function EventsPage({ api = defaultApi }: { api?: EventsApi }) {
  const [params, setParams] = useSearchParams();
  const query = readParams(params);
  const key = params.toString();
  const [draft, setDraft] = useState({
    q: query.q ?? '',
    city: query.city ?? '',
    from: query.from ?? '',
    to: query.to ?? '',
  });

  const results = useAsync(
    useCallback(
      (signal: AbortSignal) => api.search(readParams(new URLSearchParams(key)), signal),
      [api, key],
    ),
    key,
  );
  const cities = useAsync(useCallback((signal: AbortSignal) => api.cities(signal), [api]));

  function apply(next: Record<string, string | undefined>) {
    const merged = new URLSearchParams(params);
    for (const [name, value] of Object.entries(next)) {
      if (value) merged.set(name, value);
      else merged.delete(name);
    }
    setParams(merged);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    apply({ q: draft.q.trim(), city: draft.city, from: draft.from, to: draft.to, page: undefined });
  }

  return (
    <>
      <h1>Upcoming events</h1>
      <form className="card filters" onSubmit={onSubmit} role="search">
        <TextField
          label="Search"
          placeholder="Event or venue"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <SelectField
          label="City"
          value={draft.city}
          onChange={(e) => setDraft({ ...draft, city: e.target.value })}
          options={[
            { value: '', label: 'All cities' },
            ...(cities.data ?? []).map((city) => ({ value: city, label: city })),
          ]}
        />
        <TextField
          label="From"
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <TextField
          label="To"
          type="date"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
        <SelectField
          label="Sort by"
          value={`${query.sort}:${query.order}`}
          onChange={(e) => apply({ sort: e.target.value, page: undefined })}
          options={SORTS}
        />
        <div className="filters__actions">
          <Button type="submit">Search</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({ q: '', city: '', from: '', to: '' });
              setParams(new URLSearchParams());
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {results.status === 'loading' && <Spinner label="Loading events" />}
      {results.status === 'error' && (
        <ErrorMessage message={toErrorMessage(results.error)} onRetry={results.reload} />
      )}
      {results.status === 'success' && results.data.items.length === 0 && (
        <EmptyState title="No events found">
          <p>Try a different search or clear the filters.</p>
        </EmptyState>
      )}
      {results.status === 'success' && results.data.items.length > 0 && (
        <>
          <p className="muted">{results.data.meta.total} event(s)</p>
          <ul className="event-grid">
            {results.data.items.map((event) => (
              <li key={event.id} className="card event-card">
                <h2>
                  <Link to={`/events/${event.id}`}>{event.title}</Link>
                </h2>
                <p className="muted">
                  {formatDateTime(event.startAt, event.venue.timezone)} · {event.venue.name},{' '}
                  {event.venue.city}
                </p>
                <p>
                  {event.minPriceMinor !== null && event.minPriceMinor !== undefined
                    ? `From ${formatMoney(event.minPriceMinor, event.currency)}`
                    : 'Pricing soon'}
                  {event.pricing.earlyBirdActive && (
                    <span className="badge badge--up">
                      {' '}
                      Early bird −{event.pricing.earlyBirdDiscountPct}%
                    </span>
                  )}
                </p>
                <p className="muted">
                  {event.availableSeats ?? 0} of {event.totalSeats ?? 0} seats available
                </p>
              </li>
            ))}
          </ul>
          <Pagination
            page={results.data.meta.page}
            totalPages={results.data.meta.totalPages}
            onChange={(page) => apply({ page: String(page) })}
          />
        </>
      )}
    </>
  );
}
