import type TestAgent from 'supertest/lib/agent';
import type { MockProviderA } from '../../src/infrastructure/payments/MockProviders';
import type { ApiHarness } from './apiHarness';
import { newCustomer, setupPublishedEvent } from './bookingFixtures';

let keyCounter = 0;
export function idemKey(prefix = 'pay'): string {
  keyCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${keyCounter}`;
}

export interface HeldBooking {
  agent: TestAgent;
  userId: string;
  eventId: string;
  bookingId: string;
  /** Grand total charged (tickets + platform fee + VAT). */
  totalMinor: number;
  /** Ticket price part of the total (what a policy refund returns by default). */
  ticketMinor: number;
}

/** A customer with a fresh HELD booking of `seats` seats (default event 30 days out). */
export async function heldBooking(
  h: ApiHarness,
  options: { seats?: number; startInDays?: number } = {},
): Promise<HeldBooking> {
  const { eventId, seatIds } = await setupPublishedEvent(h, {
    startInDays: options.startInDays ?? 30,
  });
  const { agent, userId } = await newCustomer(h);
  const held = await agent
    .post('/api/bookings')
    .send({ eventId, seatIds: seatIds.slice(5, 5 + (options.seats ?? 1)) })
    .expect(201);
  return {
    agent,
    userId,
    eventId,
    bookingId: held.body.data.id,
    totalMinor: held.body.data.totalAmountMinor,
    ticketMinor: held.body.data.charges.ticketSubtotalMinor,
  };
}

export function pay(
  agent: TestAgent,
  bookingId: string,
  body: Record<string, unknown>,
  key: string | null = idemKey(),
) {
  const request = agent.post(`/api/bookings/${bookingId}/payments`);
  if (key) request.set('Idempotency-Key', key);
  return request.send(body);
}

/** Pays with Mock Provider B (instant capture) and returns the confirmed booking id + payment id. */
export async function confirmedBooking(
  h: ApiHarness,
  options: { startInDays?: number; token?: string } = {},
): Promise<HeldBooking & { paymentId: string }> {
  const held = await heldBooking(h, options);
  const paid = await pay(held.agent, held.bookingId, {
    provider: 'MOCK_PROVIDER_B',
    paymentMethodToken: options.token ?? 'tok_success',
  }).expect(201);
  if (paid.body.data.booking.status !== 'CONFIRMED')
    throw new Error('Expected a confirmed booking');
  return { ...held, paymentId: paid.body.data.payment.id };
}

export function mockA(h: ApiHarness): MockProviderA {
  return h.container.gateways.get('MOCK_PROVIDER_A') as MockProviderA;
}

export async function bookingStatus(h: ApiHarness, bookingId: string): Promise<string> {
  const { rows } = await h.testDb.db.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return rows[0]!.status;
}

export async function paymentRows(h: ApiHarness, bookingId: string) {
  const { rows } = await h.testDb.db.query<{ id: string; status: string; transaction_ref: string }>(
    'SELECT id, status, transaction_ref FROM payments WHERE booking_id = $1 ORDER BY created_at',
    [bookingId],
  );
  return rows;
}

export async function historyTo(h: ApiHarness, bookingId: string, to: string): Promise<number> {
  const { rows } = await h.testDb.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM booking_status_history WHERE booking_id = $1 AND to_status = $2',
    [bookingId, to],
  );
  return rows[0]!.n;
}
