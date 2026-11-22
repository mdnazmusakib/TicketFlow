import request from 'supertest';
import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';
import { FakeSslCommerz } from '../../helpers/fakeSslCommerz';
import {
  bookingStatus,
  heldBooking,
  historyTo,
  pay,
  paymentRows,
} from '../../helpers/paymentFixtures';

let h: ApiHarness;
const ssl = new FakeSslCommerz();

beforeAll(async () => {
  h = await createApiHarness({ otpBypass: true, paymentGateways: [ssl.adapter()] });
});

afterAll(async () => {
  await h.close();
});

async function startSslPayment() {
  const held = await heldBooking(h);
  const started = await pay(held.agent, held.bookingId, { provider: 'SSLCOMMERZ' }).expect(201);
  return {
    ...held,
    payment: started.body.data.payment as {
      id: string;
      transactionRef: string;
      status: string;
      redirectUrl: string;
    },
  };
}

function postIpn(body: Record<string, string>) {
  return request(h.app).post('/api/payments/webhooks/SSLCOMMERZ').type('form').send(body);
}

describe('SSLCommerz integration (adapter against a simulated sandbox API)', () => {
  it('creates a hosted session and redirects the customer to SSLCommerz', async () => {
    const { payment } = await startSslPayment();
    expect(payment.status).toBe('PENDING');
    expect(payment.redirectUrl).toMatch(
      /^https:\/\/sandbox\.sslcommerz\.com\/gwprocess\/v4\/gw\.php/,
    );
    expect(payment.transactionRef.length).toBeLessThanOrEqual(30);
    expect(ssl.sessions.get(payment.transactionRef)).toMatchObject({
      currency: 'BDT',
      status: 'PENDING',
    });
  });

  it('confirms only after a signed IPN AND a successful server-side validation', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef);
    const response = await postIpn(ssl.ipn(payment.transactionRef)).expect(200);
    expect(response.body.data.status).toBe('processed');
    expect(ssl.calls).toContain('/validator/api/validationserverAPI.php');
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');

    // IPN retries are acknowledged without re-applying.
    const duplicate = await postIpn(ssl.ipn(payment.transactionRef)).expect(200);
    expect(duplicate.body.data.status).toBe('duplicate');
    expect(await historyTo(h, bookingId, 'CONFIRMED')).toBe(1);
  });

  it('rejects IPNs with a bad verify_sign', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef);
    const forged = ssl.ipn(payment.transactionRef, 'VALID', 'wrong-password');
    const response = await postIpn(forged);
    expect(response.status).toBe(401);
    const tampered = { ...ssl.ipn(payment.transactionRef), amount: '1.00' };
    expect((await postIpn(tampered)).status).toBe(401);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
  });

  it('a validly signed IPN still cannot confirm an unpaid transaction (validation API is the truth)', async () => {
    const { bookingId, payment } = await startSslPayment();
    // Customer has not paid; IPN claims VALID.
    await postIpn(ssl.ipn(payment.transactionRef, 'VALID')).expect(200);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    expect((await paymentRows(h, bookingId))[0]!.status).toBe('PENDING');
  });

  it('refuses to confirm when the validated amount does not match the booking', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef, { reportedAmount: '1.00' });
    await postIpn(ssl.ipn(payment.transactionRef)).expect(200);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    expect((await paymentRows(h, bookingId))[0]!.status).toBe('FAILED');
  });

  it('holds high-risk transactions for review instead of confirming', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef, { riskLevel: '1' });
    await postIpn(ssl.ipn(payment.transactionRef)).expect(200);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    expect((await paymentRows(h, bookingId))[0]!.status).toBe('PENDING');
  });

  it('the browser success return triggers validation, then redirects to the result page', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef);
    const session = ssl.sessions.get(payment.transactionRef)!;
    // The posted status is ignored; only tran_id/val_id are used to validate server-side.
    const response = await request(h.app)
      .post('/api/payments/providers/sslcommerz/return/success')
      .set('Origin', 'https://sandbox.sslcommerz.com')
      .type('form')
      .send({ tran_id: payment.transactionRef, val_id: session.valId, status: 'VALID' });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`http://localhost:5173/payments/${payment.id}/result`);
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');
  });

  it('a forged "success" return for an unpaid transaction confirms nothing', async () => {
    const { bookingId, payment } = await startSslPayment();
    const response = await request(h.app)
      .post('/api/payments/providers/sslcommerz/return/success')
      .type('form')
      .send({ tran_id: payment.transactionRef, status: 'VALID' });
    expect(response.status).toBe(303);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    const unknown = await request(h.app)
      .post('/api/payments/providers/sslcommerz/return/fail')
      .type('form')
      .send({ tran_id: 'nope' });
    expect(unknown.headers.location).toBe('http://localhost:5173/payments/unknown/result');
  });

  it('keeps the attempt open when validation is unreachable, then resolves on reconciliation', async () => {
    const { bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef);
    ssl.failValidation = true;
    await postIpn(ssl.ipn(payment.transactionRef)).expect(200);
    expect(await bookingStatus(h, bookingId)).toBe('PENDING_PAYMENT');
    ssl.failValidation = false;
    await h.container.services.payments.reconcileOpen(50, 0);
    expect(await bookingStatus(h, bookingId)).toBe('CONFIRMED');
  });

  it('refunds through the SSLCommerz refund API and polls until refunded', async () => {
    const { agent, bookingId, payment } = await startSslPayment();
    ssl.pay(payment.transactionRef);
    await postIpn(ssl.ipn(payment.transactionRef)).expect(200);

    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.refundDecision.refundable).toBe(true);
    expect(cancelled.body.data.refunds[0]).toMatchObject({ status: 'PROCESSING' });
    expect(ssl.refundCalls).toBe(1);
    expect(ssl.refundTransIds[0]).toMatch(/^RT[0-9a-f]{28}$/);

    const refundId = cancelled.body.data.refunds[0].id as string;
    await h.testDb.db.query(
      `UPDATE refunds SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [refundId],
    );
    await h.container.services.refunds.processDue();
    const view = await agent.get(`/api/bookings/${bookingId}`).expect(200);
    expect(view.body.data.refunds[0].status).toBe('SUCCEEDED');
    expect(view.body.data.refundAmountMinor).toBe(view.body.data.totalAmountMinor);
    expect(ssl.refundCalls).toBe(1); // polled status, did not refund twice
  });
});
