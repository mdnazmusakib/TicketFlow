import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';
import { seatStates } from '../../helpers/bookingFixtures';
import { confirmedBooking, heldBooking, pay, paymentRows } from '../../helpers/paymentFixtures';

const HOUR = 3_600_000;

describe('Cancellation and refunds', () => {
  let h: ApiHarness;
  // Fixed business clock: makes the exact 24-hour boundary testable.
  const fixedNow = new Date(Math.floor(Date.now() / 1000) * 1000);

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true, now: () => fixedNow });
  });

  afterAll(async () => {
    await h.close();
  });

  async function setEventStart(bookingId: string, startAt: Date) {
    await h.testDb.db.query(
      `UPDATE events SET start_at = $2 WHERE id = (SELECT event_id FROM bookings WHERE id = $1)`,
      [bookingId, startAt],
    );
  }

  it('full refund when cancelled more than 24 hours before the event', async () => {
    const { agent, bookingId, totalMinor } = await confirmedBooking(h, { startInDays: 10 });
    const preview = await agent.get(`/api/bookings/${bookingId}/cancellation`).expect(200);
    expect(preview.body.data).toMatchObject({
      refundable: true,
      refundAmountMinor: totalMinor,
      cancellable: true,
    });

    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      refundAmountMinor: totalMinor,
      refundDecision: { refundable: true, refundAmountMinor: totalMinor },
    });
    expect(cancelled.body.data.refunds).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', amountMinor: totalMinor, attempt: 1 }),
    ]);
    expect(cancelled.body.data.history.at(-1)).toMatchObject({
      to: 'CANCELLED',
      reason: 'cancelled by customer (full refund)',
    });
    expect(await seatStates(h, bookingId)).toEqual(['RELEASED']);
  });

  it('no refund when cancelled within 24 hours of the event (seats still released)', async () => {
    const { agent, bookingId } = await confirmedBooking(h);
    await setEventStart(bookingId, new Date(fixedNow.getTime() + 5 * HOUR));
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      refundAmountMinor: 0,
      refunds: [],
    });
    expect(cancelled.body.data.refundDecision).toMatchObject({
      refundable: false,
      refundAmountMinor: 0,
    });
    expect(await seatStates(h, bookingId)).toEqual(['RELEASED']);
  });

  it('exactly 24 hours before the event is NOT more than 24 hours: no refund', async () => {
    const { agent, bookingId } = await confirmedBooking(h);
    await setEventStart(bookingId, new Date(fixedNow.getTime() + 24 * HOUR));
    const preview = await agent.get(`/api/bookings/${bookingId}/cancellation`).expect(200);
    expect(preview.body.data).toMatchObject({ refundable: false, hoursUntilEvent: 24 });
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.refundDecision.refundable).toBe(false);
  });

  it('24 hours and 1 second before the event: full refund', async () => {
    const { agent, bookingId, totalMinor } = await confirmedBooking(h);
    await setEventStart(bookingId, new Date(fixedNow.getTime() + 24 * HOUR + 1000));
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.refundDecision).toMatchObject({
      refundable: true,
      refundAmountMinor: totalMinor,
    });
  });

  it('retries a failed refund and never refunds twice', async () => {
    const { agent, bookingId, totalMinor, paymentId } = await confirmedBooking(h, {
      token: 'tok_refund_fail_once',
    });
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.refunds[0]).toMatchObject({
      status: 'FAILED',
      attempt: 1,
      failureReason: 'Issuer temporarily unavailable',
      nextRetryAt: expect.any(String),
    });
    expect(cancelled.body.data.refundAmountMinor).toBe(0);

    const retried = await agent.post(`/api/bookings/${bookingId}/refunds/retry`).expect(200);
    expect(retried.body.data.refunds.map((r: { status: string }) => r.status)).toEqual([
      'FAILED',
      'SUCCEEDED',
    ]);
    expect(retried.body.data.refundAmountMinor).toBe(totalMinor);

    // Idempotent: nothing left to retry, and re-processing a succeeded refund is a no-op.
    expect((await agent.post(`/api/bookings/${bookingId}/refunds/retry`)).status).toBe(409);
    expect(await h.container.services.refunds.retry(paymentId)).toMatchObject({
      status: 'SUCCEEDED',
      attempt: 2,
    });
    const { rows } = await h.testDb.db.query(
      `SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`,
      [paymentId],
    );
    expect(rows[0]?.n).toBe(2);
    expect((await agent.post(`/api/bookings/${bookingId}/cancel`)).status).toBe(409);
  });

  it('the worker retries failed refunds when their retry time comes', async () => {
    const { agent, bookingId } = await confirmedBooking(h, { token: 'tok_refund_fail_once' });
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    const refundId = cancelled.body.data.refunds[0].id as string;
    await h.testDb.db.query(
      `UPDATE refunds SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [refundId],
    );
    await h.container.services.refunds.processDue();
    const view = await agent.get(`/api/bookings/${bookingId}`).expect(200);
    expect(view.body.data.refunds.at(-1)).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
  });

  it('cancelling before payment closes the open attempt; nothing is refunded', async () => {
    const { agent, bookingId } = await heldBooking(h);
    await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', refunds: [] });
    expect((await paymentRows(h, bookingId)).map((p) => p.status)).toEqual(['CANCELLED']);
    expect(await seatStates(h, bookingId)).toEqual(['RELEASED']);
  });

  it('a payment completed just before cancelling is honoured and refunded by the rules', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const started = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_timeout',
    }).expect(201);
    expect(started.body.data.payment.status).toBe('PENDING');
    // Cancel while the outcome is unknown: the service verifies first (captured), confirms, then cancels with a refund.
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.refunds[0]).toMatchObject({ status: 'SUCCEEDED' });
    expect((await paymentRows(h, bookingId)).map((p) => p.status)).toEqual(['SUCCEEDED']);
  });

  it('other customers cannot preview or cancel', async () => {
    const { bookingId } = await confirmedBooking(h);
    const other = await heldBooking(h);
    expect((await other.agent.get(`/api/bookings/${bookingId}/cancellation`)).status).toBe(404);
    expect((await other.agent.post(`/api/bookings/${bookingId}/cancel`)).status).toBe(404);
  });
});
