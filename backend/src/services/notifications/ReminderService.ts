import type { Logger } from 'pino';
import type { TransactionRunner } from '../../infrastructure/database/types';
import type { NotificationDispatcher } from './NotificationDispatcher';

/**
 * Pre-event reminders (PRD §3.9): for every CONFIRMED booking whose event starts
 * within the reminder window but still at least one hour from now, mark
 * `bookings.reminder_sent_at` and enqueue the Email + In-App reminder in the
 * SAME transaction. Rows are claimed with FOR UPDATE SKIP LOCKED, so parallel
 * workers or a restarted worker can never schedule the same reminder twice; a
 * booking whose window was missed (< 1 hour left, or already started) is not
 * reminded.
 */
export class ReminderService {
  constructor(
    private readonly db: TransactionRunner,
    private readonly dispatcher: NotificationDispatcher,
    private readonly options: { windowMinutes: number; batchSize?: number; logger?: Logger },
  ) {}

  async scheduleDue(): Promise<number> {
    const scheduled = await this.db.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT b.id FROM bookings b JOIN events e ON e.id = b.event_id
         WHERE b.status = 'CONFIRMED' AND b.reminder_sent_at IS NULL
           AND e.status = 'PUBLISHED'
           AND e.start_at >= now() + interval '1 hour'
           AND e.start_at <= now() + make_interval(mins => $1)
         ORDER BY e.start_at
         LIMIT $2
         FOR UPDATE OF b SKIP LOCKED`,
        [this.options.windowMinutes, this.options.batchSize ?? 200],
      );
      const ids: string[] = [];
      for (const { id } of rows) {
        const marked = await tx.query(
          'UPDATE bookings SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL',
          [id],
        );
        if ((marked.rowCount ?? 0) === 0) continue;
        await this.dispatcher.enqueueForBooking(tx, 'EVENT_REMINDER_1H', id);
        ids.push(id);
      }
      return ids;
    });
    if (scheduled.length > 0)
      this.options.logger?.info({ reminders: scheduled.length }, 'Event reminders scheduled');
    return scheduled.length;
  }
}
