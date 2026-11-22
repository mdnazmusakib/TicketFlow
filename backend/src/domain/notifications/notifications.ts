/** Notification model shared by the dispatcher, channels and the in-app inbox. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'IN_APP'] as const;
export type NotificationChannelName = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'BOOKING_CONFIRMED',
  'BOOKING_CANCELLED',
  'EVENT_REMINDER_1H',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface OutgoingNotification {
  id: string;
  type: NotificationType;
  channel: NotificationChannelName;
  title: string;
  message: string;
  /** Unique per (type, booking, channel): repeat deliveries can be recognised downstream. */
  dedupeKey: string;
  recipient: { userId: string; name: string; email: string };
}

/**
 * A delivery channel (Strategy). Adding SMS or push = one new class registered
 * with the dispatcher; booking code is untouched. `deliver` must throw on
 * failure so the outbox schedules a retry.
 */
export interface NotificationChannel {
  readonly name: NotificationChannelName;
  deliver(notification: OutgoingNotification): Promise<void>;
}

/** Reminders go out when the event starts in at most this window, but never with < 1 hour left. */
export const REMINDER_MIN_LEAD_MS = 60 * 60 * 1000;

/**
 * Exponential backoff for notification retries: 30 s, 1, 2, 4 … minutes, capped at 30.
 */
export function notificationRetryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}
