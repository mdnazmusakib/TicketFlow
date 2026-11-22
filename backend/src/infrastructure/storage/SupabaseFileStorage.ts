import type { FileStorage } from '../../domain/uploads/FileStorage';
import { IMAGE_KEY_PATTERN, mimeForKey } from '../../domain/uploads/images';

type FetchLike = typeof fetch;

export interface SupabaseStorageConfig {
  /** Project URL, e.g. https://<ref>.supabase.co */
  url: string;
  /** Service-role key: server-side only, never sent to browsers. */
  serviceRoleKey: string;
  bucket: string;
  timeoutMs?: number;
}

/**
 * Supabase Storage (S3-compatible object storage) through its REST API. Used on hosts
 * with an ephemeral filesystem (e.g. Render free), so banners survive restarts and
 * redeploys. The bucket is private: images are read by the API and served from
 * /uploads/<key> with the same safe headers as local files.
 */
export class SupabaseFileStorage implements FileStorage {
  private readonly base: string;
  private bucketReady: Promise<void> | undefined;

  constructor(
    private readonly config: SupabaseStorageConfig,
    private readonly fetchImpl: FetchLike = (...args) => fetch(...args),
  ) {
    this.base = `${config.url.replace(/\/+$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      apikey: this.config.serviceRoleKey,
      ...extra,
    };
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
  }

  /** Creates the private bucket once if it does not exist (idempotent). */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const response = await this.call('/bucket', {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          id: this.config.bucket,
          name: this.config.bucket,
          public: false,
          file_size_limit: 2 * 1024 * 1024,
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
        }),
      });
      // 200 created; 400/409 "already exists" are fine.
      if (!response.ok && response.status !== 409 && response.status !== 400) {
        throw new Error(`Supabase Storage bucket setup failed (${response.status})`);
      }
    })().catch((error: unknown) => {
      this.bucketReady = undefined; // retry on the next upload
      throw error;
    });
    return this.bucketReady;
  }

  private objectPath(key: string): string | null {
    return IMAGE_KEY_PATTERN.test(key)
      ? `/object/${encodeURIComponent(this.config.bucket)}/${key}`
      : null;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.objectPath(key);
    if (!path) throw new Error('Invalid storage key');
    await this.ensureBucket();
    const response = await this.call(path, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': mimeForKey(key)!,
        'x-upsert': 'false', // never overwrite
        'Cache-Control': 'max-age=86400',
      }),
      body: new Uint8Array(data),
    });
    if (!response.ok) throw new Error(`Supabase Storage upload failed (${response.status})`);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.objectPath(key);
    if (!path) return null;
    const response = await this.call(path, { method: 'GET', headers: this.headers() });
    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Supabase Storage read failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const path = this.objectPath(key);
    if (!path) return;
    const response = await this.call(path, { method: 'DELETE', headers: this.headers() });
    if (!response.ok && response.status !== 400 && response.status !== 404) {
      throw new Error(`Supabase Storage delete failed (${response.status})`);
    }
  }
}
