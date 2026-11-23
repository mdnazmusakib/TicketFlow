import request from 'supertest';
import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';
import { newCustomer } from '../../helpers/bookingFixtures';
import { confirmedBooking, heldBooking } from '../../helpers/paymentFixtures';

interface NotificationRow {
  id: string;
  channel: string;
  type: string;
  delivery_status: string;
  attempts: number;
  last_error: string | null;
  message: string;
}

describe('Notifications: outbox delivery, reminders and in-app inbox', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
  });

  afterAll(async () => {
    await h.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const dispatcher = () => h.container.services.notifications;
  const reminders = () => h.container.services.reminders;

  async function rowsFor(bookingId: string, type?: string): Promise<NotificationRow[]> {
    const { rows } = await h.testDb.db.query<NotificationRow>(
      `SELECT id, channel, type, delivery_status, attempts, last_error, message FROM notifications
       WHERE booking_id = $1 AND ($2::varchar IS NULL OR type = $2) ORDER BY channel`,
      [bookingId, type ?? null],
    );
    return rows;
  }

  async function emailOf(userId: string): Promise<string> {
    const { rows } = await h.testDb.db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]!.email;
  }

  async function makeDue(bookingId: string) {
    await h.testDb.db.query(
      `UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE booking_id = $1`,
      [bookingId],
    );
  }

  async function setEventStart(bookingId: string, sqlOffset: string) {
    await h.testDb.db.query(
      `UPDATE events SET start_at = now() + $2::interval
       WHERE id = (SELECT event_id FROM bookings WHERE id = $1)`,
      [bookingId, sqlOffset],
    );
  }

  /** Drains the outbox (several passes, so every due row is handled). */
  async function drain() {
    while ((await dispatcher().deliverDue(200)) > 0) {
      /* keep going */
    }
  }

  describe('booking confirmation', () => {
    it('enqueues Email + In-App in the confirming transaction and delivers both', async () => {
      const { agent, bookingId, userId } = await confirmedBooking(h);
      const queued = await rowsFor(bookingId);
      expect(queued.map((r) => [r.channel, r.type, r.delivery_status])).toEqual([
        ['EMAIL', 'BOOKING_CONFIRMED', 'PENDING'],
        ['IN_APP', 'BOOKING_CONFIRMED', 'PENDING'],
      ]);
      // In-app notifications appear only once delivered.
      expect((await agent.get('/api/notifications').expect(200)).body.data).toEqual([]);

      await drain();
      const email = await emailOf(userId);
      const sent = h.emails.sent.filter((m) => m.to === email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toMatch(/^Your TicketFlow tickets: /);
      expect(sent[0]!.text).toContain(bookingId);
      expect(sent[0]!.idempotencyKey).toBe(`BOOKING_CONFIRMED:${bookingId}:EMAIL`);
      expect((await rowsFor(bookingId)).every((r) => r.delivery_status === 'SENT')).toBe(true);

      const inbox = await agent.get('/api/notifications').expect(200);
      expect(inbox.body.data).toEqual([
        expect.objectContaining({
          type: 'BOOKING_CONFIRMED',
          bookingId,
          isRead: false,
          title: 'Booking confirmed',
        }),
      ]);
      expect(inbox.body.meta).toMatchObject({ total: 1, unreadCount: 1 });
      expect((await agent.get('/api/notifications/unread-count').expect(200)).body.data).toEqual({
        unreadCount: 1,
      });
    });

    it('never creates a notification twice for the same booking (dedupe key)', async () => {
      const { bookingId, userId } = await confirmedBooking(h);
      const again = await h.testDb.db.withTransaction((tx) =>
        dispatcher().enqueueForBooking(tx, 'BOOKING_CONFIRMED', bookingId),
      );
      expect(again).toEqual([]);
      expect(await rowsFor(bookingId)).toHaveLength(2);
      await drain();
      await drain();
      const email = await emailOf(userId);
      expect(h.emails.sent.filter((m) => m.to === email)).toHaveLength(1);
    });

    it('rolls the notification back together with a failed booking transaction', async () => {
      const { bookingId } = await heldBooking(h);
      await expect(
        h.testDb.db.withTransaction(async (tx) => {
          await dispatcher().enqueueForBooking(tx, 'BOOKING_CONFIRMED', bookingId);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await rowsFor(bookingId)).toEqual([]);
    });
  });

  describe('retries', () => {
    it('in-app notifications are delivered even when email delivery fails', async () => {
      const { agent, bookingId } = await confirmedBooking(h);
      jest.spyOn(h.emails, 'send').mockRejectedValue(new Error('SMTP unavailable'));
      await drain();
      const rows = await rowsFor(bookingId, 'BOOKING_CONFIRMED');
      expect(rows.map((r) => [r.channel, r.delivery_status])).toEqual([
        ['EMAIL', 'FAILED'],
        ['IN_APP', 'SENT'],
      ]);
      const inbox = await agent.get('/api/notifications').expect(200);
      expect(inbox.body.data).toEqual([
        expect.objectContaining({ type: 'BOOKING_CONFIRMED', bookingId, isRead: false }),
      ]);
      expect((await agent.get('/api/notifications/unread-count').expect(200)).body.data).toEqual({
        unreadCount: 1,
      });
      jest.restoreAllMocks();
    });

    it('retries a failed email with backoff and then delivers it', async () => {
      const { bookingId, userId } = await confirmedBooking(h);
      const email = await emailOf(userId);
      const original = h.emails.send.bind(h.emails);
      jest.spyOn(h.emails, 'send').mockImplementation(async (message) => {
        if (message.to === email) throw new Error('SMTP unavailable');
        return original(message);
      });
      await drain();
      const [failed] = await rowsFor(bookingId, 'BOOKING_CONFIRMED');
      expect(failed).toMatchObject({
        channel: 'EMAIL',
        delivery_status: 'FAILED',
        attempts: 1,
        last_error: 'SMTP unavailable',
      });
      const { rows } = await h.testDb.db.query<{ wait: number }>(
        `SELECT extract(epoch FROM next_attempt_at - now())::int AS wait FROM notifications WHERE id = $1`,
        [failed!.id],
      );
      expect(rows[0]!.wait).toBeGreaterThanOrEqual(25); // 30 s backoff, not retried immediately
      expect(await dispatcher().deliverDue()).toBe(0);

      jest.restoreAllMocks();
      await makeDue(bookingId);
      await drain();
      const [retried] = await rowsFor(bookingId, 'BOOKING_CONFIRMED');
      expect(retried).toMatchObject({ delivery_status: 'SENT', attempts: 2, last_error: null });
      expect(h.emails.sent.filter((m) => m.to === email)).toHaveLength(1);
    });

    it('stops retrying after the maximum number of attempts', async () => {
      const { bookingId, userId } = await confirmedBooking(h);
      const email = await emailOf(userId);
      const max = h.config.notifications.maxAttempts;
      await h.testDb.db.query(
        `UPDATE notifications SET attempts = $2 - 1 WHERE booking_id = $1 AND channel = 'EMAIL'`,
        [bookingId, max],
      );
      const original = h.emails.send.bind(h.emails);
      jest.spyOn(h.emails, 'send').mockImplementation(async (message) => {
        if (message.to === email) throw new Error('mailbox rejected');
        return original(message);
      });
      await drain();
      await makeDue(bookingId);
      await drain();
      const [email1] = await rowsFor(bookingId, 'BOOKING_CONFIRMED');
      expect(email1).toMatchObject({ delivery_status: 'FAILED', attempts: max });
    });

    it('reclaims a row whose worker crashed mid-delivery (expired lease)', async () => {
      const { bookingId } = await confirmedBooking(h);
      await h.testDb.db.query(
        `UPDATE notifications SET delivery_status = 'PROCESSING', attempts = 1,
           next_attempt_at = now() - interval '1 second' WHERE booking_id = $1`,
        [bookingId],
      );
      await drain();
      expect((await rowsFor(bookingId)).map((r) => [r.delivery_status, r.attempts])).toEqual([
        ['SENT', 2],
        ['SENT', 2],
      ]);
    });

    it('parallel workers deliver each notification exactly once', async () => {
      const bookings = await Promise.all([
        confirmedBooking(h),
        confirmedBooking(h),
        confirmedBooking(h),
      ]);
      await Promise.all([
        dispatcher().deliverDue(),
        dispatcher().deliverDue(),
        dispatcher().deliverDue(),
      ]);
      await drain();
      for (const { userId, bookingId } of bookings) {
        const email = await emailOf(userId);
        expect(h.emails.sent.filter((m) => m.to === email)).toHaveLength(1);
        expect(
          (await rowsFor(bookingId)).every((r) => r.delivery_status === 'SENT' && r.attempts === 1),
        ).toBe(true);
      }
    });
  });

  describe('cancellation', () => {
    it('notifies a paid cancellation with the refund outcome', async () => {
      const { agent, bookingId, userId, totalMinor } = await confirmedBooking(h, {
        startInDays: 10,
      });
      await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
      const rows = await rowsFor(bookingId, 'BOOKING_CANCELLED');
      expect(rows.map((r) => r.channel)).toEqual(['EMAIL', 'IN_APP']);
      expect(rows[0]!.message).toMatch(/full refund/i);
      await drain();
      const email = await emailOf(userId);
      const cancelled = h.emails.sent.find(
        (m) => m.to === email && m.subject.startsWith('Booking cancelled'),
      );
      expect(cancelled?.text).toContain(
        `A full refund of BDT ${(totalMinor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      );
      const inbox = await agent.get('/api/notifications').expect(200);
      expect(inbox.body.data.map((n: { type: string }) => n.type)).toEqual([
        'BOOKING_CANCELLED',
        'BOOKING_CONFIRMED',
      ]);
    });

    it('notifies a late cancellation that no refund applies', async () => {
      const { agent, bookingId } = await confirmedBooking(h);
      await setEventStart(bookingId, '5 hours');
      await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
      const [email] = await rowsFor(bookingId, 'BOOKING_CANCELLED');
      expect(email!.message).toMatch(/no refund/i);
    });

    it('notifies an unpaid (held) cancellation without refund wording', async () => {
      const { agent, bookingId } = await heldBooking(h);
      await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
      const rows = await rowsFor(bookingId, 'BOOKING_CANCELLED');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.message).not.toMatch(/refund/i);
    });
  });

  describe('event reminders', () => {
    it('schedules once for an event starting within the window and at least 1 hour away', async () => {
      const { bookingId, userId } = await confirmedBooking(h);
      await setEventStart(bookingId, '90 minutes');
      expect(await reminders().scheduleDue()).toBeGreaterThanOrEqual(1);
      const { rows } = await h.testDb.db.query<{ reminder_sent_at: Date | null }>(
        'SELECT reminder_sent_at FROM bookings WHERE id = $1',
        [bookingId],
      );
      expect(rows[0]!.reminder_sent_at).toBeInstanceOf(Date);
      expect((await rowsFor(bookingId, 'EVENT_REMINDER_1H')).map((r) => r.channel)).toEqual([
        'EMAIL',
        'IN_APP',
      ]);

      // A restarted / repeated pass never duplicates it.
      await reminders().scheduleDue();
      expect(await rowsFor(bookingId, 'EVENT_REMINDER_1H')).toHaveLength(2);

      await drain();
      const email = await emailOf(userId);
      expect(
        h.emails.sent.filter((m) => m.to === email && m.subject.startsWith('Reminder:')),
      ).toHaveLength(1);
    });

    it('parallel reminder workers schedule each reminder exactly once', async () => {
      const bookings = await Promise.all([confirmedBooking(h), confirmedBooking(h)]);
      for (const b of bookings) await setEventStart(b.bookingId, '100 minutes');
      await Promise.all([
        reminders().scheduleDue(),
        reminders().scheduleDue(),
        reminders().scheduleDue(),
      ]);
      for (const b of bookings)
        expect(await rowsFor(b.bookingId, 'EVENT_REMINDER_1H')).toHaveLength(2);
    });

    it('does not remind when less than 1 hour remains, the event is too far away, or the booking is not confirmed', async () => {
      const late = await confirmedBooking(h);
      await setEventStart(late.bookingId, '30 minutes');
      const far = await confirmedBooking(h);
      await setEventStart(far.bookingId, '5 hours');
      const held = await heldBooking(h);
      await setEventStart(held.bookingId, '90 minutes');
      await reminders().scheduleDue();
      for (const id of [late.bookingId, far.bookingId, held.bookingId]) {
        expect(await rowsFor(id, 'EVENT_REMINDER_1H')).toEqual([]);
      }
    });

    it('skips a queued reminder once the event has started', async () => {
      const { agent, bookingId, userId } = await confirmedBooking(h);
      await setEventStart(bookingId, '90 minutes');
      await reminders().scheduleDue();
      await setEventStart(bookingId, '-1 minute');
      await drain();
      const rows = await rowsFor(bookingId, 'EVENT_REMINDER_1H');
      expect(rows.map((r) => r.delivery_status)).toEqual(['SKIPPED', 'SKIPPED']);
      const email = await emailOf(userId);
      expect(h.emails.sent.some((m) => m.to === email && m.subject.startsWith('Reminder:'))).toBe(
        false,
      );
      const inbox = await agent.get('/api/notifications').expect(200);
      expect(inbox.body.data.some((n: { type: string }) => n.type === 'EVENT_REMINDER_1H')).toBe(
        false,
      );
    });

    it('the notification worker runs reminder scheduling and delivery together', async () => {
      const { bookingId } = await confirmedBooking(h);
      await setEventStart(bookingId, '80 minutes');
      await h.container.notificationWorker.tick();
      expect((await rowsFor(bookingId, 'EVENT_REMINDER_1H')).map((r) => r.delivery_status)).toEqual(
        ['SENT', 'SENT'],
      );
    });
  });

  describe('in-app inbox access control', () => {
    it('lists, paginates, filters and marks only the owner’s notifications', async () => {
      const { agent, bookingId } = await confirmedBooking(h, { startInDays: 10 });
      await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
      await drain();

      const page1 = await agent.get('/api/notifications?pageSize=1&page=1').expect(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.meta).toMatchObject({
        page: 1,
        pageSize: 1,
        total: 2,
        totalPages: 2,
        unreadCount: 2,
      });
      const page2 = await agent.get('/api/notifications?pageSize=1&page=2').expect(200);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);

      const target = page1.body.data[0].id as string;
      const { agent: stranger } = await newCustomer(h);
      await stranger.post(`/api/notifications/${target}/read`).expect(404);
      expect((await stranger.get('/api/notifications').expect(200)).body.data).toEqual([]);

      const read = await agent.post(`/api/notifications/${target}/read`).expect(200);
      expect(read.body.data).toMatchObject({ id: target, isRead: true });
      expect(read.body.data.readAt).toEqual(expect.any(String));
      const unread = await agent.get('/api/notifications?unreadOnly=true').expect(200);
      expect(unread.body.data.map((n: { id: string }) => n.id)).not.toContain(target);
      expect(unread.body.meta.unreadCount).toBe(1);

      const all = await agent.post('/api/notifications/read-all').expect(200);
      expect(all.body.data).toEqual({ updated: 1, unreadCount: 0 });
      expect(
        (await agent.get('/api/notifications/unread-count').expect(200)).body.data.unreadCount,
      ).toBe(0);
    });

    it('rejects anonymous access and malformed input', async () => {
      await request(h.app).get('/api/notifications').expect(401);
      const { agent } = await newCustomer(h);
      await agent.post('/api/notifications/not-a-uuid/read').expect(400);
      await agent.get('/api/notifications?pageSize=500').expect(400);
      await agent.post('/api/notifications/00000000-0000-4000-8000-000000000000/read').expect(404);
    });
  });
});
