import { useCallback, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage } from '../../components/ui/Feedback';
import { FormAlert, TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { fieldErrors, toErrorMessage } from '../../lib/apiClient';
import { useAsync } from '../../lib/useAsync';
import { organizerApi as defaultApi, type OrganizerApi } from '../events/eventsApi';
import type { Venue, VenueInput } from '../events/types';

const EMPTY: VenueInput = {
  name: '',
  address: '',
  city: '',
  countryCode: 'BD',
  timezone: 'Asia/Dhaka',
};

export function VenuesPage({ api = defaultApi }: { api?: OrganizerApi }) {
  const venues = useAsync(useCallback((signal: AbortSignal) => api.listVenues(signal), [api]));
  const [form, setForm] = useState<VenueInput>(EMPTY);
  const [editing, setEditing] = useState<Venue | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(venue: Venue) {
    setEditing(venue);
    setForm({
      name: venue.name,
      address: venue.address,
      city: venue.city,
      countryCode: venue.countryCode,
      timezone: venue.timezone,
    });
    setErrors({});
    setMessage(null);
  }

  function reset() {
    setEditing(null);
    setForm(EMPTY);
    setErrors({});
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (editing) await api.updateVenue(editing.id, form);
      else await api.createVenue(form);
      setMessage({ tone: 'success', text: editing ? 'Venue updated' : 'Venue created' });
      reset();
      venues.reload();
    } catch (err) {
      setErrors(fieldErrors(err));
      setMessage({ tone: 'error', text: toErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(venue: Venue) {
    if (!window.confirm(`Delete venue "${venue.name}"?`)) return;
    try {
      await api.deleteVenue(venue.id);
      setMessage({ tone: 'success', text: 'Venue deleted' });
      venues.reload();
    } catch (err) {
      setMessage({ tone: 'error', text: toErrorMessage(err) });
    }
  }

  const set = (key: keyof VenueInput) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <div className="grid">
      <section className="card">
        <h1>Venues</h1>
        {venues.status === 'loading' && <Spinner label="Loading venues" />}
        {venues.status === 'error' && (
          <ErrorMessage message={toErrorMessage(venues.error)} onRetry={venues.reload} />
        )}
        {venues.status === 'success' && venues.data.length === 0 && (
          <EmptyState title="No venues yet">
            <p>Add your first venue to start creating events.</p>
          </EmptyState>
        )}
        {venues.status === 'success' && venues.data.length > 0 && (
          <ul className="list">
            {venues.data.map((venue) => (
              <li key={venue.id} className="list__item">
                <div>
                  <strong>{venue.name}</strong>
                  <div className="muted">
                    {venue.address}, {venue.city} · {venue.timezone}
                  </div>
                </div>
                <div className="list__actions">
                  <Button variant="secondary" onClick={() => startEdit(venue)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => onDelete(venue)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>{editing ? `Edit ${editing.name}` : 'Add a venue'}</h2>
        <form onSubmit={onSubmit} noValidate>
          <FormAlert message={message?.text} tone={message?.tone} />
          <TextField
            label="Name"
            required
            value={form.name}
            onChange={set('name')}
            error={errors.name}
          />
          <TextField
            label="Address"
            required
            value={form.address}
            onChange={set('address')}
            error={errors.address}
          />
          <TextField
            label="City"
            required
            value={form.city}
            onChange={set('city')}
            error={errors.city}
          />
          <TextField
            label="Country code"
            maxLength={2}
            value={form.countryCode}
            onChange={set('countryCode')}
            error={errors.countryCode}
          />
          <TextField
            label="Time zone (IANA)"
            value={form.timezone}
            onChange={set('timezone')}
            error={errors.timezone}
          />
          <div className="form-actions">
            <Button type="submit" disabled={busy}>
              {editing ? 'Save venue' : 'Add venue'}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
