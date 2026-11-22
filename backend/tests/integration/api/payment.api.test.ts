import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApiHarness, signUp, type ApiHarness } from '../../helpers/apiHarness';
import { expireHoldNow, seatStates } from '../../helpers/bookingFixtures';
import {
  bookingStatus,
  heldBooking,
  historyTo,
  idemKey,
  mockA,
  pay,
  paymentRows,
} from '../../helpers/paymentFixtures';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness({ otpBypass: true });
});

afterAll(async () => {
  await h.close();
});

function postWebhook(provider: string, rawBody: Buffer, headers: Record<string, string>) {
  return request(h.app)
    .post(`/api/payments/webhooks/${provider}`)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(rawBody.toString('utf8'));
}

describe('Payments: Mock Provider A (hosted checkout + signed webhook)', () => {
  it('requires an Idempotency-Key and lists enabled providers', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const missing = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }, null);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('headers.idempotency-key');

    const providers = await agent.get('/api/payments/providers').expect(200);
    expect(providers.body.data.providers).toEqual(
      expect.arrayContaining(['MOCK_PROVIDER_A', 'MOCK_PROVIDER_B']),
    );
    expect(providers.body.data.mockProviderBTokens).toContain('tok_timeout');
  });

  it('initiates a redirect, keeps seats protected, and confirms only after the verified webhook', async () => {
    const { agent, bookingId, totalMinor } = await heldBooking(h, { seats: 2 });
    const started = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const { payment, booking } = started.body.data;

    expect(payment).toMatchObject({
      status: 'PENDING',
      provider: 'MOCK_PROVIDER_A',
      amountMinor: totalMinor,
    });
    expect(payment.redirectUrl).toContain(`/payments/mock-checkout?ref=${payment.transactionRef}`);
    expect(booking.status).toBe('PENDING_PAYMENT');
    // Hold extended to cover the payment window (≥ 14 minutes from now).
    expect(new Date(booking.holdExpiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await seatStates(h, bookingId)).toEqual(['HELD', 'HELD']);

    // Polling while the customer is on the hosted page changes nothing.
    const polled = await agent.get(`/api/payments/${payment.id}`).expect(200);
    expect(polled.body.data.payment.status).toBe('PENDING');

    const done = await agent
      .post('/api/payments/mock/complete')
      .send({ transactionRef: payment.transactionRef, outcome: 'success' })
      .expect(200);
    expect(done.body.data.payment.status).toBe('SUCCEEDED');
    expect(done.body.data.booking.status).toBe('CONFIRMED');
    expect(await seatStates(h, bookingId)).toEqual(['BOOKED', 'BOOKED']);
    expect(done.body.data.booking.history.at(-1)).toMatchObject({
      from: 'PENDING_PAYMENT',
      to: 'CONFIRMED',
      reason: 'payment verified (MOCK_PROVIDER_A)',
    });
    expect(done.body.data.booking.payments).toHaveLength(1);
  });

  it('acknowledges duplicate webhook deliveries without re-applying them', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const { body } = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const ref = body.data.payment.transactionRef as string;
    const delivery = await mockA(h).completeCheckout(ref, 'success');

    const results = await Promise.all(
      [0, 1, 2].map(() => postWebhook('MOCK_PROVIDER_A', delivery.rawBody, delivery.headers)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.map((r) => r.body.data.status).sort()).toEqual([
      'duplicate',
      'duplicate',
      'processed',
    ]);
    expect(await historyTo(h, bookingId, 'CONFIRMED')).toBe(1);

    const again = await postWebhook('MOCK_PROVIDER_A', delivery.rawBody, delivery.headers).expect(
      200,
    );
    expect(again.body.data.status).toBe('duplicate');
    const { rows } = await h.testDb.db.query(
      `SELECT count(*)::int AS n FROM payment_webhook_events WHERE provider = 'MOCK_PROVIDER_A' AND payment_id = $1`,
      [body.data.payment.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('rejects invalid signatures and tampered payloads, storing them as REJECTED', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const { body } = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const delivery = await mockA(h).completeCheckout(body.data.payment.transactionRef, 'success');

    const bad = await postWebhook('MOCK_PROVIDER_A', delivery.rawBody, {
      'x-mock-signature': 'f'.repeat(64),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    const tampered = Buffer.from(
      delivery.rawBody.toString('utf8').replace(/"amountMinor":\d+/, '"amountMinor":1'),
    );
    expect((await postWebhook('MOCK_PROVIDER_A', tampered, delivery.headers)).status).toBe(401);
    expect((await postWebhook('MOCK_PROVIDER_A', delivery.rawBody, {})).status).toBe(401);

    const { rows } = await h.testDb.db.query(
      `SELECT count(*)::int AS n FROM payment_webhook_events
       WHERE payment_id = $1 AND processing_status = 'REJECTED' AND signature_verified = false`,
      [body.data.payment.id],
    );
    expect(rows[0]?.n).toBe(3);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    expect((await request(h.app).post('/api/payments/webhooks/STRIPE').send({})).status).toBe(404);
  });

  it('never trusts the webhook body: a signed "succeeded" event for an unpaid charge confirms nothing', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const { body } = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const raw = Buffer.from(
      JSON.stringify({
        id: `evt_forged_${Date.now()}`,
        type: 'payment.succeeded',
        data: {
          transactionRef: body.data.payment.transactionRef,
          status: 'CAPTURED',
          amountMinor: body.data.payment.amountMinor,
        },
      }),
    );
    const signature = createHmac('sha256', h.config.payments.mockWebhookSecret)
      .update(raw)
      .digest('hex');
    await postWebhook('MOCK_PROVIDER_A', raw, { 'x-mock-signature': signature }).expect(200);
    // Provider-side verification says the customer has not paid yet.
    expect((await paymentRows(h, bookingId))[0]!.status).toBe('PENDING');
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
  });

  it('records a declined payment and lets the customer pay again with another provider', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const { body } = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const failed = await agent
      .post('/api/payments/mock/complete')
      .send({ transactionRef: body.data.payment.transactionRef, outcome: 'failure' })
      .expect(200);
    expect(failed.body.data.payment).toMatchObject({
      status: 'FAILED',
      failureReason: 'Payment declined',
    });
    expect(failed.body.data.booking.status).toBe('PENDING_PAYMENT');

    const retry = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    }).expect(201);
    expect(retry.body.data.booking.status).toBe('CONFIRMED');
    expect((await paymentRows(h, bookingId)).map((p) => p.status)).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('cancelling an open attempt verifies it first, then allows a new attempt', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const first = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    const blocked = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PAYMENT_IN_PROGRESS');

    const cancelled = await agent
      .post(`/api/payments/${first.body.data.payment.id}/cancel`)
      .expect(200);
    expect(cancelled.body.data.payment.status).toBe('CANCELLED');
    await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    }).expect(201);
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');
  });
});

describe('Payments: Mock Provider B (direct charge, uncertain outcomes)', () => {
  it('confirms immediately on a verified capture and fails on decline', async () => {
    const ok = await heldBooking(h);
    const paid = await pay(ok.agent, ok.bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    }).expect(201);
    expect(paid.body.data.payment.status).toBe('SUCCEEDED');
    expect(paid.body.data.booking.status).toBe('CONFIRMED');

    const no = await heldBooking(h);
    const declined = await pay(no.agent, no.bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_decline',
    }).expect(201);
    expect(declined.body.data.payment.status).toBe('FAILED');
    expect(declined.body.data.booking.status).toBe('PENDING_PAYMENT');

    const bad = await heldBooking(h);
    const rejected = await pay(bad.agent, bad.bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_unknown',
    }).expect(201);
    expect(rejected.body.data.payment).toMatchObject({
      status: 'FAILED',
      failureReason: 'Invalid or missing card token',
    });
  });

  it('handles a timeout after capture without charging twice', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const key = idemKey('timeout');
    const first = await pay(
      agent,
      bookingId,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_timeout' },
      key,
    ).expect(201);
    expect(first.body.data.payment.status).toBe('PENDING');
    expect(first.body.data.booking.status).toBe('PENDING_PAYMENT');

    // Client retries with the same key: stored response, no second charge attempt.
    const replay = await pay(
      agent,
      bookingId,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_timeout' },
      key,
    ).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.payment.id).toBe(first.body.data.payment.id);

    // Status check verifies with the provider and confirms.
    const status = await agent.get(`/api/payments/${first.body.data.payment.id}`).expect(200);
    expect(status.body.data.payment.status).toBe('SUCCEEDED');
    expect(status.body.data.booking.status).toBe('CONFIRMED');
    expect(await paymentRows(h, bookingId)).toHaveLength(1);
  });

  it('settles asynchronous payments through reconciliation', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const started = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_pending',
    }).expect(201);
    expect(started.body.data.payment.status).toBe('SUCCEEDED'); // re-verified right away: settled
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');
  });

  it('reconciliation worker resolves attempts with unknown outcomes', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const started = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_timeout',
    }).expect(201);
    expect(started.body.data.payment.status).toBe('PENDING');
    await h.container.services.payments.reconcileOpen(50, 0);
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');
  });
});

describe('Payments: idempotency and concurrency', () => {
  it('rejects reuse of a key with a different payload', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const key = idemKey('mismatch');
    await pay(
      agent,
      bookingId,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_decline' },
      key,
    ).expect(201);
    const mismatch = await pay(
      agent,
      bookingId,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_success' },
      key,
    );
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('concurrent requests with the same key create exactly one payment', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const key = idemKey('same');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }, key)),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
    responses
      .filter((r) => r.status === 409)
      .forEach((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS'));
    expect(await paymentRows(h, bookingId)).toHaveLength(1);
  });

  it('concurrent requests with different keys still allow only one open attempt', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }, idemKey('diff')),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      responses
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'PAYMENT_IN_PROGRESS'),
    ).toBe(true);
    expect(await paymentRows(h, bookingId)).toHaveLength(1);
  });

  it('protects ownership: other customers get 404, organizers 403', async () => {
    const { bookingId } = await heldBooking(h);
    const stranger = await signUp(h, 'CUSTOMER');
    expect((await pay(stranger.agent, bookingId, { provider: 'MOCK_PROVIDER_A' })).status).toBe(
      404,
    );
    const organizer = await signUp(h, 'ORGANIZER');
    expect((await pay(organizer.agent, bookingId, { provider: 'MOCK_PROVIDER_A' })).status).toBe(
      403,
    );
  });

  it('does not take payments for expired holds', async () => {
    const { agent, bookingId } = await heldBooking(h);
    await expireHoldNow(h, bookingId);
    const response = await pay(agent, bookingId, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('HOLD_EXPIRED');
    expect(await paymentRows(h, bookingId)).toHaveLength(0);
  });

  it('refunds a payment that completes after the hold expired (never confirms it)', async () => {
    const { agent, bookingId } = await heldBooking(h);
    const { body } = await pay(agent, bookingId, { provider: 'MOCK_PROVIDER_A' }).expect(201);
    await expireHoldNow(h, bookingId);
    await h.container.services.bookingExpiry.expireDue();
    expect(await bookingStatus(h, bookingId)).toBe('EXPIRED');

    const late = await agent
      .post('/api/payments/mock/complete')
      .send({ transactionRef: body.data.payment.transactionRef, outcome: 'success' })
      .expect(200);
    expect(late.body.data.payment.status).toBe('SUCCEEDED');
    expect(late.body.data.booking.status).toBe('EXPIRED');
    expect(late.body.data.booking.refunds[0]).toMatchObject({
      status: 'SUCCEEDED',
      amountMinor: body.data.payment.amountMinor,
      reason: 'Payment received after the seat hold expired',
    });
    expect(await historyTo(h, bookingId, 'CONFIRMED')).toBe(0);
  });
});
