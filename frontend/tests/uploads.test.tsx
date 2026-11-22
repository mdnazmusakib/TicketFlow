import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrganizerApi } from '../src/features/events/eventsApi';
import { bannerFileError, BannerUpload } from '../src/features/organizer/BannerUpload';
import { ApiClient, ApiError } from '../src/lib/apiClient';

const file = (name: string, type: string, size = 1000) =>
  new File([new Uint8Array(size)], name, { type });

function fakeApi() {
  return {
    uploadBanner: jest
      .fn()
      .mockResolvedValue({ bannerUrl: 'http://localhost:4000/uploads/new.png' }),
    removeBanner: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<OrganizerApi>;
}

describe('BannerUpload', () => {
  it('pre-checks type and size on the client', () => {
    expect(bannerFileError(file('a.png', 'image/png'))).toBeNull();
    expect(bannerFileError(file('a.webp', 'image/webp'))).toBeNull();
    expect(bannerFileError(file('a.gif', 'image/gif'))).toMatch(/JPEG, PNG or WebP/);
    expect(bannerFileError(file('a.svg', 'image/svg+xml'))).toMatch(/JPEG, PNG or WebP/);
    expect(bannerFileError(file('a.jpg', 'image/jpeg', 2 * 1024 * 1024 + 1))).toMatch(/2 MB/);
  });

  it('uploads, previews, replaces and removes a banner', async () => {
    const api = fakeApi();
    render(<BannerUpload eventId="e1" api={api} initialUrl={null} />);
    expect(screen.getByText('No banner yet.')).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText('Upload image'), file('b.png', 'image/png'));
    expect(await screen.findByRole('img', { name: 'Current event banner' })).toHaveAttribute(
      'src',
      'http://localhost:4000/uploads/new.png',
    );
    expect(api.uploadBanner).toHaveBeenCalledWith('e1', expect.any(File));
    expect(screen.getByRole('status')).toHaveTextContent('Banner uploaded');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('No banner yet.')).toBeInTheDocument();
    expect(api.removeBanner).toHaveBeenCalledWith('e1');
  });

  it('blocks invalid files before upload and shows server rejections', async () => {
    const api = fakeApi();
    render(
      <BannerUpload eventId="e1" api={api} initialUrl="http://localhost:4000/uploads/old.png" />,
    );
    const input = screen.getByLabelText('Replace image');
    await userEvent.upload(input, file('big.png', 'image/png', 3 * 1024 * 1024));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 MB');
    expect(api.uploadBanner).not.toHaveBeenCalled();

    api.uploadBanner.mockRejectedValueOnce(
      new ApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'The file content is not a valid JPEG, PNG or WebP image',
      ),
    );
    await userEvent.upload(input, file('fake.png', 'image/png'));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid');
  });
});

describe('ApiClient multipart', () => {
  it('sends FormData as-is without a JSON content type', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { bannerUrl: 'x' } }),
    });
    const client = new ApiClient('/api', fetchMock as unknown as typeof fetch);
    const form = new FormData();
    form.append('image', file('a.png', 'image/png'));
    await client.post('/organizer/events/e1/banner', form);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.credentials).toBe('include');
  });
});
