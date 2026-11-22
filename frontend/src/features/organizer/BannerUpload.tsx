import { useId, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { FormAlert } from '../../components/ui/Form';
import { toErrorMessage } from '../../lib/apiClient';
import type { OrganizerApi } from '../events/eventsApi';

export const BANNER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;

/** Client-side pre-check for fast feedback; the server re-checks the actual file content. */
export function bannerFileError(file: File): string | null {
  if (!BANNER_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or WebP image.';
  if (file.size > BANNER_MAX_BYTES) return 'The image must be 2 MB or smaller.';
  return null;
}

/** Banner image picker for an existing event: preview, upload, remove. */
export function BannerUpload({
  eventId,
  api,
  initialUrl,
}: {
  eventId: string;
  api: OrganizerApi;
  initialUrl: string | null;
}) {
  const inputId = useId();
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = bannerFileError(file);
    if (problem) {
      setMessage({ tone: 'error', text: problem });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.uploadBanner(eventId, file);
      setUrl(result.bannerUrl);
      setMessage({ tone: 'success', text: 'Banner uploaded' });
    } catch (err) {
      setMessage({ tone: 'error', text: toErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    setMessage(null);
    try {
      await api.removeBanner(eventId);
      setUrl(null);
      setMessage({ tone: 'success', text: 'Banner removed' });
    } catch (err) {
      setMessage({ tone: 'error', text: toErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="banner-upload">
      <legend>Banner image</legend>
      {url ? (
        <img className="banner-upload__preview" src={url} alt="Current event banner" />
      ) : (
        <p className="muted">No banner yet.</p>
      )}
      <div className="list__actions">
        <label className="btn btn--secondary" htmlFor={inputId} aria-disabled={busy}>
          {busy ? 'Working…' : url ? 'Replace image' : 'Upload image'}
        </label>
        <input
          id={inputId}
          className="visually-hidden"
          type="file"
          accept={BANNER_TYPES.join(',')}
          disabled={busy}
          onChange={onFile}
          aria-describedby={`${inputId}-hint`}
        />
        {url && (
          <Button variant="ghost" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <p id={`${inputId}-hint`} className="field__hint">
        JPEG, PNG or WebP, up to 2 MB.
      </p>
      <FormAlert message={message?.text} tone={message?.tone} />
    </fieldset>
  );
}
