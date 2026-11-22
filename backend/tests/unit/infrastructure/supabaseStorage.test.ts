import { SupabaseFileStorage } from '../../../src/infrastructure/storage/SupabaseFileStorage';
import { loadConfig } from '../../../src/config/env';

const KEY = '0b3f6c1e-8a2d-4c5b-9e7f-1a2b3c4d5e6f.png';
const config = {
  url: 'https://abc.supabase.co/',
  serviceRoleKey: 'service-role-key-for-tests-0123456789',
  bucket: 'event-banners',
};

function respond(status: number, body: string | Buffer | null = null) {
  return new Response(
    body === null ? null : typeof body === 'string' ? body : new Uint8Array(body),
    { status },
  );
}

describe('SupabaseFileStorage', () => {
  it('creates the private bucket once, uploads without overwrite, reads and deletes', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(respond(200, '{}')) // bucket
      .mockResolvedValueOnce(respond(200, '{}')) // upload 1
      .mockResolvedValueOnce(respond(200, '{}')) // upload 2 (bucket cached)
      .mockResolvedValueOnce(respond(200, Buffer.from('img')))
      .mockResolvedValueOnce(respond(200, '{}'));
    const storage = new SupabaseFileStorage(config, fetchMock as unknown as typeof fetch);

    await storage.put(KEY, Buffer.from('img'));
    await storage.put(KEY.replace('.png', '.webp'), Buffer.from('img'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [bucketUrl, bucketInit] = fetchMock.mock.calls[0];
    expect(bucketUrl).toBe('https://abc.supabase.co/storage/v1/bucket');
    expect(JSON.parse(bucketInit.body)).toMatchObject({ id: 'event-banners', public: false });
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe(`https://abc.supabase.co/storage/v1/object/event-banners/${KEY}`);
    expect(uploadInit.headers).toMatchObject({
      'Content-Type': 'image/png',
      'x-upsert': 'false',
      Authorization: `Bearer ${config.serviceRoleKey}`,
    });

    expect((await storage.get(KEY))?.toString()).toBe('img');
    await storage.remove(KEY);
    expect(fetchMock.mock.calls[4][1].method).toBe('DELETE');
  });

  it('treats an existing bucket as ready, missing objects as null, and errors as failures', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(respond(409, '{"error":"Duplicate"}'))
      .mockResolvedValueOnce(respond(500, 'boom'))
      .mockResolvedValueOnce(respond(404, '{}'))
      .mockResolvedValueOnce(respond(404, '{}'));
    const storage = new SupabaseFileStorage(config, fetchMock as unknown as typeof fetch);
    await expect(storage.put(KEY, Buffer.from('x'))).rejects.toThrow('upload failed (500)');
    expect(await storage.get(KEY)).toBeNull();
    await expect(storage.remove(KEY)).resolves.toBeUndefined();
  });

  it('never calls the API for keys it did not generate', async () => {
    const fetchMock = jest.fn();
    const storage = new SupabaseFileStorage(config, fetchMock as unknown as typeof fetch);
    await expect(storage.put('../evil.png', Buffer.from('x'))).rejects.toThrow(
      'Invalid storage key',
    );
    expect(await storage.get('other-bucket/x.png')).toBeNull();
    await storage.remove('../x.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries bucket setup after a failure', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200, '{}'))
      .mockResolvedValueOnce(respond(200, '{}'));
    const storage = new SupabaseFileStorage(config, fetchMock as unknown as typeof fetch);
    await expect(storage.put(KEY, Buffer.from('x'))).rejects.toThrow('bucket setup failed');
    await storage.put(KEY, Buffer.from('x'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('storage and cookie configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'Zq8vN3kL0pR7tX2wY5bC9dF4gH6jK1mQzA0sD8fG3hJ',
    CORS_ORIGINS: 'http://localhost:5173',
  };

  it('selects Supabase Storage only with its credentials', () => {
    expect(loadConfig(base).uploads).toEqual({ driver: 'local', dir: 'uploads' });
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'supabase' })).toThrow(
      /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required/,
    );
    expect(
      loadConfig({
        ...base,
        STORAGE_DRIVER: 'supabase',
        SUPABASE_URL: config.url,
        SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey,
      }).uploads,
    ).toEqual({
      driver: 'supabase',
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      bucket: 'event-banners',
    });
  });

  it('SameSite=None requires Secure cookies', () => {
    expect(() => loadConfig({ ...base, COOKIE_SAMESITE: 'none' })).toThrow(
      /requires COOKIE_SECURE=true/,
    );
    expect(
      loadConfig({ ...base, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' }).auth.cookie,
    ).toMatchObject({
      sameSite: 'none',
      secure: true,
    });
  });
});
