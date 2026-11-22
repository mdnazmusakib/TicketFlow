import type { EmailSender } from '../../domain/notifications/email';
import type {
  NotificationChannel,
  OutgoingNotification,
} from '../../domain/notifications/notifications';

/** Email channel: hands the rendered message to the configured mailer (console in dev, SMTP in production). */
export class EmailChannel implements NotificationChannel {
  readonly name = 'EMAIL' as const;

  constructor(private readonly sender: EmailSender) {}

  async deliver(notification: OutgoingNotification): Promise<void> {
    await this.sender.send({
      to: notification.recipient.email,
      subject: notification.title,
      text: notification.message,
      idempotencyKey: notification.dedupeKey,
    });
  }
}

/**
 * In-app channel: the notification row itself is the user's inbox entry, so
 * it is visible as soon as the business transaction commits. Delivery only
 * marks it as handed over (a push/websocket fan-out would plug in here).
 */
export class InAppChannel implements NotificationChannel {
  readonly name = 'IN_APP' as const;

  async deliver(): Promise<void> {
    // Nothing to send: persisted rows are read through the inbox API.
  }
}
