import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { canManageResource, type Actor } from '../../domain/auth/roles';
import { isEditableStatus } from '../../domain/events/eventRules';
import type { FileStorage } from '../../domain/uploads/FileStorage';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  detectImageKind,
  IMAGE_KEY_PATTERN,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  mimeForKey,
} from '../../domain/uploads/images';
import type { TransactionRunner } from '../../infrastructure/database/types';
import type { EventRepository } from '../../repositories/EventRepository';
import {
  AppError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
} from '../../shared/errors/AppError';

export interface UploadedImage {
  buffer: Buffer;
  /** Client-declared type: must be allowed AND match the detected content. */
  mimetype: string;
  size: number;
}

/**
 * Event banner images: content-verified (magic bytes), size-limited, stored
 * under a random server-generated name and served from /uploads/<key>.
 */
export class EventBannerService {
  private readonly publicPrefix: string;

  constructor(
    private readonly db: TransactionRunner,
    private readonly events: EventRepository,
    private readonly storage: FileStorage,
    publicApiUrl: string,
    private readonly logger?: Logger,
  ) {
    this.publicPrefix = `${publicApiUrl}/uploads/`;
  }

  /** Validates an upload and returns its detected type (throws a client error otherwise). */
  static validate(file: UploadedImage): keyof typeof IMAGE_TYPES {
    if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
      throw new PayloadTooLargeError('Image must be 2 MB or smaller');
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      throw new AppError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Only JPEG, PNG and WebP images are allowed',
      );
    }
    const kind = detectImageKind(file.buffer);
    if (!kind || IMAGE_TYPES[kind].mime !== file.mimetype) {
      throw new AppError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'The file content is not a valid JPEG, PNG or WebP image',
      );
    }
    return kind;
  }

  async setBanner(
    actor: Actor,
    eventId: string,
    file: UploadedImage,
  ): Promise<{ bannerUrl: string }> {
    const kind = EventBannerService.validate(file);
    const key = `${randomUUID()}.${IMAGE_TYPES[kind].ext}`;
    const bannerUrl = `${this.publicPrefix}${key}`;

    await this.storage.put(key, file.buffer);
    let previous: string | null;
    try {
      previous = await this.db.withTransaction(async (tx) => {
        const event = await this.events.findById(eventId, tx, true);
        if (!event || !canManageResource(actor, event.organizerId)) {
          throw new NotFoundError('Event not found');
        }
        if (!isEditableStatus(event.status)) {
          throw new ConflictError(`A ${event.status.toLowerCase()} event cannot be edited`);
        }
        await this.events.setBannerUrl(eventId, bannerUrl, tx);
        return event.bannerUrl;
      });
    } catch (error) {
      await this.storage.remove(key); // Nothing references it.
      throw error;
    }
    await this.removeStored(previous);
    return { bannerUrl };
  }

  async removeBanner(actor: Actor, eventId: string): Promise<void> {
    const previous = await this.db.withTransaction(async (tx) => {
      const event = await this.events.findById(eventId, tx, true);
      if (!event || !canManageResource(actor, event.organizerId)) {
        throw new NotFoundError('Event not found');
      }
      if (!isEditableStatus(event.status)) {
        throw new ConflictError(`A ${event.status.toLowerCase()} event cannot be edited`);
      }
      await this.events.setBannerUrl(eventId, null, tx);
      return event.bannerUrl;
    });
    await this.removeStored(previous);
  }

  /** Public read of a stored image; unknown or malformed keys look the same (404). */
  async read(key: string): Promise<{ data: Buffer; contentType: string }> {
    const contentType = mimeForKey(key);
    const data = contentType ? await this.storage.get(key) : null;
    if (!contentType || !data) throw new NotFoundError('File not found');
    return { data, contentType };
  }

  /** Deletes a banner file we stored earlier (external https banners are left alone). */
  private async removeStored(url: string | null): Promise<void> {
    if (!url?.startsWith(this.publicPrefix)) return;
    const key = url.slice(this.publicPrefix.length);
    if (!IMAGE_KEY_PATTERN.test(key)) return;
    try {
      await this.storage.remove(key);
    } catch (error) {
      this.logger?.warn({ err: error }, 'Could not delete a replaced banner file');
    }
  }
}
