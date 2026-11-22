/**
 * Booking lifecycle state machine — the single source of truth for allowed
 * transitions in application code. Mirrored by the database trigger
 * `enforce_booking_status_transition` (migration 0003) as defense in depth;
 * an integration test asserts both stay identical.
 */
export const BOOKING_STATUSES = [
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> =
  Object.freeze({
    HELD: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'],
    PENDING_PAYMENT: ['CONFIRMED', 'EXPIRED', 'CANCELLED'],
    CONFIRMED: ['CANCELLED'],
    EXPIRED: [],
    CANCELLED: [],
  });

/** Statuses that occupy seats and count toward the per-user ticket limit. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
];

export const SEAT_STATES = ['HELD', 'BOOKED', 'RELEASED'] as const;
export type SeatState = (typeof SEAT_STATES)[number];

export const SEAT_STATE_TRANSITIONS: Readonly<Record<SeatState, readonly SeatState[]>> =
  Object.freeze({
    HELD: ['BOOKED', 'RELEASED'],
    BOOKED: ['RELEASED'],
    RELEASED: [],
  });

export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: 'booking' | 'seat',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${entity} transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && (BOOKING_STATUSES as readonly string[]).includes(value);
}

export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransitionBooking(from, to)) throw new InvalidTransitionError('booking', from, to);
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[status].length === 0;
}

export function canTransitionSeat(from: SeatState, to: SeatState): boolean {
  return SEAT_STATE_TRANSITIONS[from].includes(to);
}

export function assertSeatTransition(from: SeatState, to: SeatState): void {
  if (!canTransitionSeat(from, to)) throw new InvalidTransitionError('seat', from, to);
}
