import type {
  NotificationChannelName,
  NotificationType,
} from '../domain/notifications/notifications';
import type { BookingNotificationFacts } from '../domain/notifications/templates';
import type { Queryable } from '../infrastructure/database/types';

export interface NotificationRecord {
  id: string;
  userId: string;
  bookingId: string | null;
  channel: NotificationChannelName;
  type: NotificationType;
  title: string;
  message: string;
  dedupeKey: string;
  deliveryStatus: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

/** A claimed outbox row plus everything a channel needs to deliver it. */
export interface DeliveryJob extends NotificationRecord {
  recipientName: string;
  recipientEmail: string;
  eventStartAt: Date | null;
}

interface Row {
  id: string;
  user_id: string;
  booking_id: string | null;
  channel: NotificationChannelName;
  type: NotificationType;
  title: string;
  message: string;
  dedupe_key: string;
  delivery_status: NotificationRecord['deliveryStatus'];
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  is_read: boolean;
  read_at: Date | null;
  created_at: Date;
}

const toRecord = (row: Row): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  bookingId: row.booking_id,
  channel: row.channel,
  type: row.type,
  title: row.title,
  message: row.message,
  dedupeKey: row.dedupe_key,
  deliveryStatus: row.delivery_status,
  attempts: row.attempts,
  lastError: row.last_error,
  sentAt: row.sent_at,
  isRead: row.is_read,
  readAt: row.read_at,
  createdAt: row.created_at,
});

export class NotificationRepository {
  constructor(private readonly db: Queryable) {}

  /** Outbox insert (inside the business transaction). Duplicates by dedupe key are ignored. */
  async enqueue(
    tx: Queryable,
    row: {
      userId: string;
      bookingId: string | null;
      channel: NotificationChannelName;
      type: NotificationType;
      title: string;
      message: string;
      dedupeKey: string;
    },
  ): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO notifications (user_id, booking_id, channel, type, title, message, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        row.userId,
        row.bookingId,
        row.channel,
        row.type,
        row.title.slice(0, 200),
        row.message,
        row.dedupeKey,
      ],
    );
    return rows[0]?.id ?? null;
  }

  /** Booking, event and seat facts used to render notification texts. */
  async bookingFacts(
    tx: Queryable,
    bookingId: string,
  ): Promise<(BookingNotificationFacts & { customerId: string }) | null> {
    const { rows } = await tx.query<{
      customer_id: string;
      customer_name: string;
      title: string;
      start_at: Date;
      timezone: string;
      venue_name: string;
      venue_city: string;
      total_amount_minor: string;
      currency: string;
    }>(
      `SELECT b.customer_id, u.name AS customer_name, e.title, e.start_at, v.timezone, v.name AS venue_name,
              v.city AS venue_city, b.total_amount_minor, b.currency
       FROM bookings b JOIN users u ON u.id = b.customer_id JOIN events e ON e.id = b.event_id
       JOIN venues v ON v.id = e.venue_id WHERE b.id = $1`,
      [bookingId],
    );
    const row = rows[0];
    if (!row) return null;
    const seats = await tx.query<{ row_label: string; seat_number: number; category: string }>(
      `SELECT s.row_label, s.seat_number, c.name AS category FROM booking_seats bs
       JOIN seats s ON s.id = bs.seat_id JOIN seat_categories c ON c.id = s.category_id
       WHERE bs.booking_id = $1 ORDER BY length(s.row_label), s.row_label, s.seat_number`,
      [bookingId],
    );
    return {
      bookingId,
      customerId: row.customer_id,
      customerName: row.customer_name,
      eventTitle: row.title,
      eventStartAt: row.start_at,
      timezone: row.timezone,
      venueName: row.venue_name,
      venueCity: row.venue_city,
      seats: seats.rows.map((s) => ({
        row: s.row_label,
        number: s.seat_number,
        category: s.category,
      })),
      totalAmountMinor: Number(row.total_amount_minor),
      currency: row.currency,
    };
  }

  /**
   * Claims due outbox rows with a lease (FOR UPDATE SKIP LOCKED): several workers
   * never take the same row; a row whose worker died is re-claimed when its lease ends.
   */
  async claimDue(
    limit: number,
    maxAttempts: number,
    leaseSeconds: number,
    onlyIds?: string[],
  ): Promise<DeliveryJob[]> {
    const { rows } = await this.db.query<
      Row & { recipient_name: string; recipient_email: string; event_start_at: Date | null }
    >(
      `WITH due AS (
         SELECT n.id FROM notifications n
         WHERE n.delivery_status IN ('PENDING', 'PROCESSING', 'FAILED')
           AND n.next_attempt_at <= now() AND n.attempts < $2
           AND ($4::uuid[] IS NULL OR n.id = ANY($4::uuid[]))
         ORDER BY n.next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notifications n SET delivery_status = 'PROCESSING', attempts = n.attempts + 1,
         next_attempt_at = now() + make_interval(secs => $3)
       FROM due WHERE n.id = due.id
       RETURNING n.*,
         (SELECT name FROM users WHERE id = n.user_id) AS recipient_name,
         (SELECT email FROM users WHERE id = n.user_id) AS recipient_email,
         (SELECT e.start_at FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = n.booking_id) AS event_start_at`,
      [limit, maxAttempts, leaseSeconds, onlyIds ?? null],
    );
    return rows.map((row) => ({
      ...toRecord(row),
      recipientName: row.recipient_name,
      recipientEmail: row.recipient_email,
      eventStartAt: row.event_start_at,
    }));
  }

  async markSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET delivery_status = 'SENT', sent_at = now(), last_error = NULL
       WHERE id = $1 AND delivery_status = 'PROCESSING'`,
      [id],
    );
  }

  async markFailed(id: string, error: string, retryInMs: number): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET delivery_status = 'FAILED', last_error = $2,
         next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND delivery_status = 'PROCESSING'`,
      [id, error.slice(0, 500), Math.ceil(retryInMs / 1000)],
    );
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET delivery_status = 'SKIPPED', last_error = $2
       WHERE id = $1 AND delivery_status = 'PROCESSING'`,
      [id, reason.slice(0, 500)],
    );
  }

  // ------------------------------------------------------------ inbox

  async listInbox(
    userId: string,
    filter: { unreadOnly: boolean; page: number; pageSize: number },
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const { rows } = await this.db.query<Row & { total_count: number }>(
      `SELECT *, count(*) OVER()::int AS total_count FROM notifications
       WHERE user_id = $1 AND channel = 'IN_APP' AND delivery_status = 'SENT' AND ($2::boolean = false OR is_read = false)
       ORDER BY created_at DESC, id
       LIMIT $3 OFFSET $4`,
      [userId, filter.unreadOnly, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return { items: rows.map(toRecord), total: rows[0]?.total_count ?? 0 };
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND channel = 'IN_APP' AND delivery_status = 'SENT' AND is_read = false`,
      [userId],
    );
    return rows[0]?.n ?? 0;
  }

  /** Ownership is part of the WHERE clause: another user's id simply matches nothing. */
  async markRead(userId: string, id: string): Promise<NotificationRecord | null> {
    const { rows } = await this.db.query<Row>(
      `UPDATE notifications SET is_read = true, read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2 AND channel = 'IN_APP' AND delivery_status = 'SENT' RETURNING *`,
      [id, userId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markAllRead(userId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET is_read = true, read_at = now()
       WHERE user_id = $1 AND channel = 'IN_APP' AND delivery_status = 'SENT' AND is_read = false`,
      [userId],
    );
    return rowCount ?? 0;
  }

  async deliveryStats(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ delivery_status: string; n: number }>(
      'SELECT delivery_status, count(*)::int AS n FROM notifications GROUP BY delivery_status',
    );
    return Object.fromEntries(rows.map((r) => [r.delivery_status, r.n]));
  }
}
