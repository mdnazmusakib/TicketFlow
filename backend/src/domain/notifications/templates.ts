import type { NotificationChannelName, NotificationType } from './notifications';

export interface BookingNotificationFacts {
  bookingId: string;
  customerName: string;
  eventTitle: string;
  eventStartAt: Date;
  timezone: string;
  venueName: string;
  venueCity: string;
  seats: { row: string; number: number; category: string }[];
  totalAmountMinor: number;
  currency: string;
  /** Cancellation only. */
  refundAmountMinor?: number;
  refundable?: boolean;
}

export interface RenderedNotification {
  title: string;
  message: string;
}

export function formatAmount(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatWhen(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function seatList(facts: BookingNotificationFacts): string {
  return facts.seats.map((s) => `Row ${s.row} seat ${s.number} (${s.category})`).join(', ');
}

/**
 * Notification texts. In-app messages are short; emails carry the full
 * details (booking id, event, seats, amount) required by the PRD.
 */
export function renderNotification(
  type: NotificationType,
  channel: NotificationChannelName,
  facts: BookingNotificationFacts,
): RenderedNotification {
  const when = formatWhen(facts.eventStartAt, facts.timezone);
  const where = `${facts.venueName}, ${facts.venueCity}`;
  const total = formatAmount(facts.totalAmountMinor, facts.currency);

  if (type === 'BOOKING_CONFIRMED') {
    if (channel === 'IN_APP') {
      return {
        title: 'Booking confirmed',
        message: `Your tickets for ${facts.eventTitle} on ${when} are confirmed (${facts.seats.length} seat(s), ${total}).`,
      };
    }
    return {
      title: `Your TicketFlow tickets: ${facts.eventTitle}`,
      message: [
        `Hi ${facts.customerName},`,
        '',
        'Thank you for your purchase. Your booking is confirmed.',
        '',
        `Booking ID: ${facts.bookingId}`,
        `Event: ${facts.eventTitle}`,
        `When: ${when}`,
        `Where: ${where}`,
        `Seats: ${seatList(facts)}`,
        `Amount paid: ${total}`,
        '',
        'Cancellations more than 24 hours before the event are fully refunded.',
      ].join('\n'),
    };
  }

  if (type === 'BOOKING_CANCELLED') {
    const refund =
      facts.refundable && facts.refundAmountMinor
        ? `A full refund of ${formatAmount(facts.refundAmountMinor, facts.currency)} is on its way to your original payment method.`
        : facts.refundAmountMinor === undefined
          ? 'No payment was taken for this booking.'
          : 'No refund applies (cancelled within 24 hours of the event or nothing was paid).';
    if (channel === 'IN_APP') {
      return {
        title: 'Booking cancelled',
        message: `Your booking for ${facts.eventTitle} was cancelled. ${refund}`,
      };
    }
    return {
      title: `Booking cancelled: ${facts.eventTitle}`,
      message: [
        `Hi ${facts.customerName},`,
        '',
        'Your booking has been cancelled and the seats were released.',
        '',
        `Booking ID: ${facts.bookingId}`,
        `Event: ${facts.eventTitle}`,
        `When: ${when}`,
        `Seats: ${seatList(facts)}`,
        '',
        refund,
      ].join('\n'),
    };
  }

  // EVENT_REMINDER_1H
  if (channel === 'IN_APP') {
    return {
      title: 'Your event starts soon',
      message: `${facts.eventTitle} starts at ${when} at ${where}.`,
    };
  }
  return {
    title: `Reminder: ${facts.eventTitle} starts soon`,
    message: [
      `Hi ${facts.customerName},`,
      '',
      `${facts.eventTitle} starts at ${when}.`,
      `Venue: ${where}`,
      `Your seats: ${seatList(facts)}`,
      `Booking ID: ${facts.bookingId}`,
      '',
      'Please arrive a little early. Enjoy the event!',
    ].join('\n'),
  };
}
