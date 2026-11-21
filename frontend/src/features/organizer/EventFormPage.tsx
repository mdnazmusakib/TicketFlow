import { useCallback, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/Feedback';
import { FormAlert, SelectField, TextArea, TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { fieldErrors, toErrorMessage } from '../../lib/apiClient';
import { fromLocalInput, toLocalInput } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { organizerApi as defaultApi, type OrganizerApi } from '../events/eventsApi';
import type { EventDetailsInput, ManagedEventDetails, Venue } from '../events/types';
import {
  buildSeatMap,
  DEFAULT_SEAT_MAP_DRAFT,
  SeatMapBuilder,
  type SeatMapDraft,
} from './SeatMapBuilder';

interface DetailsDraft {
  venueId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  strategy: 'BASE' | 'EARLY_BIRD';
  earlyBirdDeadline: string;
  discountPct: string;
  salesStartAt: string;
  salesEndAt: string;
  bannerUrl: string;
}

const EMPTY: DetailsDraft = {
  venueId: '',
  title: '',
  description: '',
  startAt: '',
  endAt: '',
  strategy: 'BASE',
  earlyBirdDeadline: '',
  discountPct: '10',
  salesStartAt: '',
  salesEndAt: '',
  bannerUrl: '',
};

function fromEvent(event: ManagedEventDetails): DetailsDraft {
  return {
    venueId: event.venue.id,
    title: event.title,
    description: event.description ?? '',
    startAt: toLocalInput(event.startAt),
    endAt: toLocalInput(event.endAt),
    strategy: event.pricing.strategy,
    earlyBirdDeadline: toLocalInput(event.pricing.earlyBirdDeadline),
    discountPct: String(event.pricing.earlyBirdDiscountPct ?? 10),
    salesStartAt: toLocalInput(event.salesStartAt),
    salesEndAt: toLocalInput(event.salesEndAt),
    bannerUrl: event.bannerUrl ?? '',
  };
}

function toPayload(draft: DetailsDraft): EventDetailsInput {
  return {
    venueId: draft.venueId,
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    startAt: fromLocalInput(draft.startAt) ?? '',
    endAt: fromLocalInput(draft.endAt),
    pricing:
      draft.strategy === 'EARLY_BIRD'
        ? {
            strategy: 'EARLY_BIRD',
            earlyBirdDeadline: fromLocalInput(draft.earlyBirdDeadline) ?? '',
            discountPct: Number(draft.discountPct),
          }
        : { strategy: 'BASE' },
    salesStartAt: fromLocalInput(draft.salesStartAt),
    salesEndAt: fromLocalInput(draft.salesEndAt),
    bannerUrl: draft.bannerUrl.trim() || null,
  };
}

/** Create (details + seat map) or edit (details only) an event. */
export function EventFormPage({ api = defaultApi }: { api?: OrganizerApi }) {
  const { id } = useParams();
  const isEdit = Boolean(id);

  const loaded = useAsync(
    useCallback(
      async (signal: AbortSignal) => {
        const [venues, event] = await Promise.all([
          api.listVenues(signal),
          id ? api.getEvent(id, signal) : Promise.resolve(null),
        ]);
        return { venues, event };
      },
      [api, id],
    ),
    id ?? 'new',
  );

  if (loaded.status === 'loading') return <Spinner label="Loading" />;
  if (loaded.status === 'error')
    return <ErrorMessage message={toErrorMessage(loaded.error)} onRetry={loaded.reload} />;
  if (loaded.data.venues.length === 0 && !isEdit) {
    return (
      <div className="empty-state">
        <h1>Add a venue first</h1>
        <p>Events are hosted at one of your venues.</p>
        <Link className="btn btn--primary" to="/organizer/venues">
          Manage venues
        </Link>
      </div>
    );
  }

  const { venues, event } = loaded.data;
  const initial: DetailsDraft = event
    ? fromEvent(event)
    : { ...EMPTY, venueId: venues[0]?.id ?? '' };
  return <EventForm key={id ?? 'new'} id={id} api={api} venues={venues} initial={initial} />;
}

interface EventFormProps {
  id: string | undefined;
  api: OrganizerApi;
  venues: Venue[];
  initial: DetailsDraft;
}

/** The form itself; mounted once data is loaded so initial state comes straight from props. */
function EventForm({ id, api, venues, initial }: EventFormProps) {
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DetailsDraft>(initial);
  const [seatMap, setSeatMap] = useState<SeatMapDraft>(DEFAULT_SEAT_MAP_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof DetailsDraft) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: e.target.value });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setErrors({});
    const payload = toPayload(draft);
    if (!payload.startAt) {
      setErrors({ startAt: 'Start date and time are required' });
      return;
    }
    setBusy(true);
    try {
      if (isEdit && id) {
        await api.updateEvent(id, payload);
        navigate('/organizer');
      } else {
        const built = buildSeatMap(seatMap);
        if (!built.value) {
          setError(built.errors[0] ?? 'Seat map is invalid');
          return;
        }
        const created = await api.createEvent({ ...payload, seatMap: built.value });
        navigate(`/organizer/events/${created.id}/seats`);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h1>{isEdit ? 'Edit event' : 'New event'}</h1>
      <form onSubmit={onSubmit} noValidate className="event-form">
        <FormAlert message={error} />
        <TextField
          label="Title"
          required
          value={draft.title}
          onChange={set('title')}
          error={errors.title}
        />
        <TextArea
          label="Description"
          rows={4}
          value={draft.description}
          onChange={set('description')}
          error={errors.description}
        />
        <SelectField
          label="Venue"
          value={draft.venueId}
          onChange={set('venueId')}
          error={errors.venueId}
          options={venues.map((venue) => ({
            value: venue.id,
            label: `${venue.name} (${venue.city})`,
          }))}
        />
        <div className="form-row">
          <TextField
            label="Starts"
            type="datetime-local"
            required
            value={draft.startAt}
            onChange={set('startAt')}
            error={errors.startAt}
          />
          <TextField
            label="Ends (optional)"
            type="datetime-local"
            value={draft.endAt}
            onChange={set('endAt')}
            error={errors.endAt}
          />
        </div>
        <div className="form-row">
          <TextField
            label="Sales open (optional)"
            type="datetime-local"
            value={draft.salesStartAt}
            onChange={set('salesStartAt')}
          />
          <TextField
            label="Sales close (optional)"
            type="datetime-local"
            value={draft.salesEndAt}
            onChange={set('salesEndAt')}
          />
        </div>
        <fieldset>
          <legend>Pricing strategy</legend>
          <SelectField
            label="Strategy"
            value={draft.strategy}
            onChange={set('strategy')}
            options={[
              { value: 'BASE', label: 'Base price' },
              { value: 'EARLY_BIRD', label: 'Early bird discount' },
            ]}
          />
          {draft.strategy === 'EARLY_BIRD' && (
            <div className="form-row">
              <TextField
                label="Discount ends"
                type="datetime-local"
                value={draft.earlyBirdDeadline}
                onChange={set('earlyBirdDeadline')}
              />
              <TextField
                label="Discount %"
                type="number"
                min={1}
                max={99}
                value={draft.discountPct}
                onChange={set('discountPct')}
              />
            </div>
          )}
        </fieldset>
        <TextField
          label="Banner image URL (https, optional)"
          type="url"
          value={draft.bannerUrl}
          onChange={set('bannerUrl')}
          error={errors.bannerUrl}
        />

        {!isEdit && <SeatMapBuilder draft={seatMap} onChange={setSeatMap} />}

        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create draft event'}
          </Button>
          <Link className="btn btn--ghost" to="/organizer">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
