import type { Logger } from 'pino';
import {
  notificationRetryDelayMs,
  type NotificationChannel,
  type NotificationChannelName,
  type NotificationType,
} from '../../domain/notifications/notifications';
import { renderNotification } from '../../domain/notifications/templates';
import type { Queryable } from '../../infrastructure/database/types';
import type { NotificationRepository } from '../../repositories/NotificationRepository';
import type { BookingTransitionEvent } from '../booking/BookingLifecycle';

export interface DispatcherOptions {
  maxAttempts: number;
  /** How long a claimed row stays reserved for one worker before others may retry it. */
  leaseSeconds?: number;
  logger?: Logger;
  now?: () => Date;
  /** Deliver right after enqueueing (default true); the worker is always the safety net. */
  immediateDelivery?: boolean;
}

/**
 * Notification dispatcher (Observer + transactional outbox):
 * - enqueue: rows are written in the SAME transaction as the booking change, one per
 *   channel, with a unique dedupe key — a notification can never be lost by a crash
 *   after commit, nor created twice;
 * - deliver: workers claim due rows with FOR UPDATE SKIP LOCKED and a lease, send them
 *   through the matching channel, and retry failures with exponential backoff.
 * Delivery is at-least-once; the dedupe key travels with each message (e.g. as the
 * email Message-ID) so downstream systems can drop a rare duplicate.
 */
export class NotificationDispatcher {
  private readonly channels = new Map<NotificationChannelName, NotificationChannel>();
  private kickTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: NotificationRepository,
    channels: NotificationChannel[],
    private readonly options: DispatcherOptions,
  ) {
    for (const channel of channels) this.channels.set(channel.name, channel);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Writes one outbox row per channel for a booking (inside the caller's transaction). */
  async enqueueForBooking(
    tx: Queryable,
    type: NotificationType,
    bookingId: string,
    extra: { refundAmountMinor?: number; refundable?: boolean } = {},
  ): Promise<string[]> {
    const facts = await this.repository.bookingFacts(tx, bookingId);
    if (!facts) return [];
    const ids: string[] = [];
    for (const channel of this.channels.keys()) {
      const rendered = renderNotification(type, channel, { ...facts, ...extra });
      const id = await this.repository.enqueue(tx, {
        userId: facts.customerId,
        bookingId,
        channel,
        type,
        title: rendered.title,
        message: rendered.message,
        dedupeKey: `${type}:${bookingId}:${channel}`,
      });
      if (id) ids.push(id);
    }
    if (ids.length > 0) this.kick();
    return ids;
  }

  /** Lifecycle observer: confirmation and cancellation notifications. */
  readonly onBookingTransition = async (
    tx: Queryable,
    event: BookingTransitionEvent,
  ): Promise<void> => {
    if (event.to === 'CONFIRMED') {
      await this.enqueueForBooking(tx, 'BOOKING_CONFIRMED', event.booking.id);
    } else if (event.to === 'CANCELLED') {
      const details = event.context.details ?? {};
      const paid = event.from === 'CONFIRMED';
      await this.enqueueForBooking(tx, 'BOOKING_CANCELLED', event.booking.id, {
        ...(paid
          ? {
              refundable: details.refundable === true,
              refundAmountMinor:
                typeof details.refundAmountMinor === 'number' ? details.refundAmountMinor : 0,
            }
          : {}),
      });
    }
  };

  /** Sends due outbox rows. Returns how many were processed. */
  async deliverDue(limit = 50): Promise<number> {
    const jobs = await this.repository.claimDue(
      limit,
      this.options.maxAttempts,
      this.options.leaseSeconds ?? 300,
    );
    for (const job of jobs) {
      if (
        job.type === 'EVENT_REMINDER_1H' &&
        job.eventStartAt &&
        job.eventStartAt.getTime() <= this.now().getTime()
      ) {
        await this.repository.markSkipped(job.id, 'Event already started');
        continue;
      }
      const channel = this.channels.get(job.channel);
      if (!channel) {
        await this.repository.markFailed(
          job.id,
          `No channel registered for ${job.channel}`,
          notificationRetryDelayMs(job.attempts),
        );
        continue;
      }
      try {
        await channel.deliver({
          id: job.id,
          type: job.type,
          channel: job.channel,
          title: job.title,
          message: job.message,
          dedupeKey: job.dedupeKey,
          recipient: { userId: job.userId, name: job.recipientName, email: job.recipientEmail },
        });
        await this.repository.markSent(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn(
          { notificationId: job.id, attempt: job.attempts, err: error },
          'Notification delivery failed',
        );
        await this.repository.markFailed(job.id, message, notificationRetryDelayMs(job.attempts));
      }
    }
    return jobs.length;
  }

  /** Requests a delivery pass shortly after a commit (the worker is the safety net). */
  private kick(): void {
    if (this.options.immediateDelivery === false || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      this.deliverDue().catch((error: unknown) =>
        this.options.logger?.error({ err: error }, 'Immediate notification delivery failed'),
      );
    }, 250);
    this.kickTimer.unref();
  }

  /** Cancels a pending kick (used on shutdown). */
  stop(): void {
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = undefined;
  }
}
