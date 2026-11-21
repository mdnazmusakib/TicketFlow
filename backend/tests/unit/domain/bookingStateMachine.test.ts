import {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  InvalidTransitionError,
  SEAT_STATES,
  assertBookingTransition,
  assertSeatTransition,
  canTransitionBooking,
  canTransitionSeat,
  isBookingStatus,
  isTerminalBookingStatus,
} from '../../../src/domain/lifecycle/bookingStateMachine';

describe('booking state machine', () => {
  it.each([
    ['HELD', 'PENDING_PAYMENT'],
    ['HELD', 'EXPIRED'],
    ['HELD', 'CANCELLED'],
    ['PENDING_PAYMENT', 'CONFIRMED'],
    ['PENDING_PAYMENT', 'EXPIRED'],
    ['PENDING_PAYMENT', 'CANCELLED'],
    ['CONFIRMED', 'CANCELLED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(true);
    expect(() => assertBookingTransition(from, to)).not.toThrow();
  });

  it.each([
    ['HELD', 'CONFIRMED'],
    ['HELD', 'HELD'],
    ['CONFIRMED', 'EXPIRED'],
    ['CONFIRMED', 'PENDING_PAYMENT'],
    ['EXPIRED', 'HELD'],
    ['EXPIRED', 'CONFIRMED'],
    ['CANCELLED', 'CONFIRMED'],
    ['CANCELLED', 'HELD'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(false);
    expect(() => assertBookingTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('has a transition entry for every status and terminal EXPIRED/CANCELLED', () => {
    expect(Object.keys(BOOKING_TRANSITIONS).sort()).toEqual([...BOOKING_STATUSES].sort());
    expect(isTerminalBookingStatus('EXPIRED')).toBe(true);
    expect(isTerminalBookingStatus('CANCELLED')).toBe(true);
    expect(isTerminalBookingStatus('HELD')).toBe(false);
    expect(Object.isFrozen(BOOKING_TRANSITIONS)).toBe(true);
  });

  it('counts HELD, PENDING_PAYMENT and CONFIRMED toward the ticket limit', () => {
    expect([...ACTIVE_BOOKING_STATUSES].sort()).toEqual(['CONFIRMED', 'HELD', 'PENDING_PAYMENT']);
  });

  it('type-guards status strings', () => {
    expect(isBookingStatus('HELD')).toBe(true);
    expect(isBookingStatus('held')).toBe(false);
    expect(isBookingStatus(42)).toBe(false);
  });

  it('describes the failed transition', () => {
    const error = new InvalidTransitionError('booking', 'EXPIRED', 'CONFIRMED');
    expect(error.message).toBe('Invalid booking transition EXPIRED -> CONFIRMED');
    expect(error).toMatchObject({ entity: 'booking', from: 'EXPIRED', to: 'CONFIRMED' });
  });
});

describe('seat state machine', () => {
  it('allows HELD->BOOKED, HELD->RELEASED, BOOKED->RELEASED only', () => {
    const allowed = SEAT_STATES.flatMap((from) =>
      SEAT_STATES.filter((to) => canTransitionSeat(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(['BOOKED->RELEASED', 'HELD->BOOKED', 'HELD->RELEASED']);
    expect(() => assertSeatTransition('RELEASED', 'HELD')).toThrow('Invalid seat transition RELEASED -> HELD');
    expect(() => assertSeatTransition('HELD', 'BOOKED')).not.toThrow();
  });
});
