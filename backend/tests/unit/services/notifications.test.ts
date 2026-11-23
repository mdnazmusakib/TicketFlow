import {
  notificationRetryDelayMs,
  type NotificationChannel,
} from '../../../src/domain/notifications/notifications';
import {
  formatAmount,
  renderNotification,
  type BookingNotificationFacts,
} from '../../../src/domain/notifications/templates';
import { maskEmail } from '../../../src/repositories/DashboardRepository';
import type {
  DeliveryJob,
  NotificationRepository,
} from '../../../src/repositories/NotificationRepository';
import type { BookingTransitionEvent } from '../../../src/services/booking/BookingLifecycle';
import { EmailChannel, InAppChannel } from '../../../src/services/notifications/channels';
import { NotificationDispatcher } from '../../../src/services/notifications/NotificationDispatcher';
import { IntervalWorker } from '../../../src/workers/IntervalWorker';

const facts: BookingNotificationFacts = {
  bookingId: 'b-1',
  customerName: 'Rahim',
  eventTitle: 'Rock Night',
  eventStartAt: new Date('2026-12-24T14:00:00Z'),
  timezone: 'Asia/Dhaka',
  venueName: 'Arena',
  venueCity: 'Dhaka',
  seats: [{ row: 'A', number: 1, category: 'VIP' }],
  totalAmountMinor: 250000,
  currency: 'BDT',
};

describe('notification templates', () => {
  it('formats amounts in minor units', () => {
    expect(formatAmount(250000, 'BDT')).toBe('BDT 2,500.00');
    expect(formatAmount(5, 'USD')).toBe('USD 0.05');
  });

  it('confirmation email carries booking id, event, venue, seats and amount', () => {
    const email = renderNotification('BOOKING_CONFIRMED', 'EMAIL', facts);
    expect(email.title).toBe('Your TicketFlow tickets: Rock Night');
    for (const part of ['b-1', 'Rock Night', 'Arena, Dhaka', 'Row A seat 1', 'BDT 2,500.00']) {
      expect(email.message).toContain(part);
    }
    // Shown in the venue's time zone (UTC+6).
    expect(email.message).toContain('20:00');
    expect(renderNotification('BOOKING_CONFIRMED', 'IN_APP', facts).message.length).toBeLessThan(
      email.message.length,
    );
  });

  it('cancellation wording follows the refund outcome', () => {
    expect(
      renderNotification('BOOKING_CANCELLED', 'IN_APP', {
        ...facts,
        refundable: true,
        refundAmountMinor: 250000,
      }).message,
    ).toContain('A refund of BDT 2,500.00 (full ticket price)');
    expect(
      renderNotification('BOOKING_CANCELLED', 'IN_APP', {
        ...facts,
        refundable: false,
        refundAmountMinor: 0,
      }).message,
    ).toContain('No refund applies');
    expect(renderNotification('BOOKING_CANCELLED', 'IN_APP', facts).message).toContain(
      'No payment was taken',
    );
  });

  it('reminder names the event, time and place', () => {
    const reminder = renderNotification('EVENT_REMINDER_1H', 'EMAIL', facts);
    expect(reminder.title).toBe('Reminder: Rock Night starts soon');
    expect(reminder.message).toContain('Arena, Dhaka');
  });
});

describe('notification retry backoff', () => {
  it('doubles from 30 s and caps at 30 minutes', () => {
    expect([1, 2, 3, 4].map(notificationRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(notificationRetryDelayMs(20)).toBe(30 * 60_000);
    expect(notificationRetryDelayMs(0)).toBe(30_000);
  });
});

describe('maskEmail', () => {
  it('hides most of the local part', () => {
    expect(maskEmail('rahim.uddin@example.com')).not.toContain('rahim.uddin');
    expect(maskEmail('rahim.uddin@example.com')).toMatch(/^r.*\*.*@example\.com$/);
    expect(maskEmail('a@x.io')).toContain('@x.io');
  });
});

describe('channels', () => {
  const notification = {
    id: 'n1',
    type: 'BOOKING_CONFIRMED' as const,
    channel: 'EMAIL' as const,
    title: 'Subject',
    message: 'Body',
    dedupeKey: 'BOOKING_CONFIRMED:b-1:EMAIL',
    recipient: { userId: 'u1', name: 'Rahim', email: 'r@example.com' },
  };

  it('EmailChannel sends to the recipient with the dedupe key as idempotency key', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await new EmailChannel({ send }).deliver(notification);
    expect(send).toHaveBeenCalledWith({
      to: 'r@example.com',
      subject: 'Subject',
      text: 'Body',
      idempotencyKey: 'BOOKING_CONFIRMED:b-1:EMAIL',
    });
  });

  it('EmailChannel propagates failures so the outbox retries', async () => {
    const send = jest.fn().mockRejectedValue(new Error('down'));
    await expect(new EmailChannel({ send }).deliver(notification)).rejects.toThrow('down');
  });

  it('InAppChannel delivery is the stored row itself', async () => {
    await expect(new InAppChannel().deliver()).resolves.toBeUndefined();
  });
});

describe('NotificationDispatcher', () => {
  function job(overrides: Partial<DeliveryJob> = {}): DeliveryJob {
    return {
      id: 'n1',
      userId: 'u1',
      bookingId: 'b-1',
      channel: 'EMAIL',
      type: 'BOOKING_CONFIRMED',
      title: 't',
      message: 'm',
      dedupeKey: 'k',
      deliveryStatus: 'PROCESSING',
      attempts: 1,
      isRead: false,
      readAt: null,
      createdAt: new Date(),
      recipientName: 'R',
      recipientEmail: 'r@example.com',
      eventStartAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    } as DeliveryJob;
  }

  function fakeRepo(jobs: DeliveryJob[]) {
    return {
      claimDue: jest.fn().mockResolvedValue(jobs),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markSkipped: jest.fn().mockResolvedValue(undefined),
      bookingFacts: jest.fn().mockResolvedValue({ ...facts, customerId: 'u1' }),
      enqueue: jest.fn().mockResolvedValue('id'),
    };
  }

  const okChannel = (name: 'EMAIL' | 'IN_APP'): NotificationChannel => ({
    name,
    deliver: jest.fn().mockResolvedValue(undefined),
  });

  it('marks sent, schedules a backoff retry on failure, and skips reminders for started events', async () => {
    const failing: NotificationChannel = {
      name: 'IN_APP',
      deliver: jest.fn().mockRejectedValue(new Error('nope')),
    };
    const repo = fakeRepo([
      job({ id: 'ok' }),
      job({ id: 'bad', channel: 'IN_APP', attempts: 3 }),
      job({ id: 'late', type: 'EVENT_REMINDER_1H', eventStartAt: new Date(Date.now() - 1000) }),
    ]);
    const dispatcher = new NotificationDispatcher(
      repo as unknown as NotificationRepository,
      [okChannel('EMAIL'), failing],
      {
        maxAttempts: 8,
        immediateDelivery: false,
      },
    );
    expect(await dispatcher.deliverDue()).toBe(3);
    expect(repo.markSent).toHaveBeenCalledWith('ok');
    expect(repo.markFailed).toHaveBeenCalledWith('bad', 'nope', 120_000);
    expect(repo.markSkipped).toHaveBeenCalledWith('late', 'Event already started');
  });

  it('observer enqueues confirmation and refund-aware cancellation per channel; ignores other transitions', async () => {
    const repo = fakeRepo([]);
    const dispatcher = new NotificationDispatcher(
      repo as unknown as NotificationRepository,
      [okChannel('EMAIL'), okChannel('IN_APP')],
      {
        maxAttempts: 8,
        immediateDelivery: false,
      },
    );
    const tx = {} as never;
    const base = {
      booking: { id: 'b-1' },
      context: { reason: 'x' },
    } as unknown as BookingTransitionEvent;
    await dispatcher.onBookingTransition(tx, { ...base, from: 'PENDING_PAYMENT', to: 'CONFIRMED' });
    expect(repo.enqueue.mock.calls.map((c) => c[1].dedupeKey)).toEqual([
      'BOOKING_CONFIRMED:b-1:EMAIL',
      'BOOKING_CONFIRMED:b-1:IN_APP',
    ]);
    repo.enqueue.mockClear();
    await dispatcher.onBookingTransition(tx, {
      ...base,
      from: 'CONFIRMED',
      to: 'CANCELLED',
      context: {
        reason: 'x',
        actorId: null,
        details: { refundable: true, refundAmountMinor: 250000 },
      },
    });
    expect(repo.enqueue.mock.calls[0]![1].message).toContain(
      'A refund of BDT 2,500.00 (full ticket price)',
    );
    repo.enqueue.mockClear();
    await dispatcher.onBookingTransition(tx, { ...base, from: 'HELD', to: 'PENDING_PAYMENT' });
    await dispatcher.onBookingTransition(tx, { ...base, from: 'HELD', to: 'EXPIRED' });
    expect(repo.enqueue).not.toHaveBeenCalled();
  });
});

describe('IntervalWorker', () => {
  it('never overlaps itself, survives failures and stops cleanly', async () => {
    let release: () => void = () => undefined;
    const task = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const error = jest.fn();
    const worker = new IntervalWorker(task, {
      intervalMs: 60_000,
      name: 't',
      logger: { error } as never,
    });
    const first = worker.tick();
    const overlapping = worker.tick();
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, overlapping]);
    await worker.tick();
    expect(error).toHaveBeenCalledTimes(1);
    worker.start();
    await worker.stop();
    expect(task).toHaveBeenCalledTimes(3);
  });
});
