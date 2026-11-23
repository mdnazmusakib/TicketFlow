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
  /** Grand total paid = ticket subtotal + platform fee + VAT. */
  totalAmountMinor: number;
  currency: string;
  /** Booking price breakdown snapshot (zero fee/VAT for bookings made before fees existed). */
  ticketSubtotalMinor?: number;
  platformFeeMinor?: number;
  platformFeePerSeatMinor?: number;
  vatMinor?: number;
  vatRateBps?: number;
  /** Cancellation only. */
  refundAmountMinor?: number;
  refundable?: boolean;
  /** Cancellation only: platform fee / VAT included in the refund. */
  refundPlatformFeeMinor?: number;
  refundVatMinor?: number;
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

/** "2%" / "7.5%" from basis points, without floating-point noise. */
export function formatRate(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return fraction === 0
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

/** Receipt lines: tickets, platform charge, VAT and total, each labelled. */
function chargeLines(facts: BookingNotificationFacts): string[] {
  const money = (minor: number) => formatAmount(minor, facts.currency);
  const fee = facts.platformFeeMinor ?? 0;
  const vat = facts.vatMinor ?? 0;
  if (fee === 0 && vat === 0) return [`Amount paid: ${money(facts.totalAmountMinor)}`];
  return [
    `Tickets (${facts.seats.length} seat(s)): ${money(facts.ticketSubtotalMinor ?? facts.totalAmountMinor - fee - vat)}`,
    `Platform charge (${money(facts.platformFeePerSeatMinor ?? 0)} per seat): ${money(fee)}`,
    `VAT (${formatRate(facts.vatRateBps ?? 0)} of ticket price): ${money(vat)}`,
    `Total paid: ${money(facts.totalAmountMinor)}`,
  ];
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
        ...chargeLines(facts),
        '',
        'Cancellations more than 24 hours before the event get the ticket price back.',
      ].join('\n'),
    };
  }

  if (type === 'BOOKING_CANCELLED') {
    const keptFee = (facts.platformFeeMinor ?? 0) - (facts.refundPlatformFeeMinor ?? 0);
    const keptVat = (facts.vatMinor ?? 0) - (facts.refundVatMinor ?? 0);
    const kept =
      keptFee > 0 || keptVat > 0
        ? ` The platform charge (${formatAmount(keptFee, facts.currency)}) and VAT (${formatAmount(keptVat, facts.currency)}) are not refundable.`
        : '';
    const refund =
      facts.refundable && facts.refundAmountMinor
        ? `A refund of ${formatAmount(facts.refundAmountMinor, facts.currency)} (full ticket price) is on its way to your original payment method.${kept}`
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
