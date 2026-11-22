import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { SslCommerzAdapter } from '../../src/infrastructure/payments/SslCommerzAdapter';
import { createApiHarness, type ApiHarness } from '../helpers/apiHarness';
import { bookingStatus, heldBooking, pay, paymentRows } from '../helpers/paymentFixtures';

/**
 * Real SSLCommerz SANDBOX checks that need no public tunnel (npm run test:sandbox).
 * Credentials come from backend/.env via the runner; nothing is printed.
 * Not covered here (needs a customer paying on the hosted page + public IPN URL):
 * a real VALID capture and a real refund of it.
 */
const storeId = process.env.SSLCOMMERZ_STORE_ID;
const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD;
if (!storeId || !storePassword) {
  throw new Error('SSLCOMMERZ_STORE_ID / SSLCOMMERZ_STORE_PASSWORD are required (backend/.env)');
}
if (process.env.SSLCOMMERZ_SANDBOX === 'false') {
  throw new Error('Refusing to run sandbox tests against the live SSLCommerz gateway');
}

const publicApiUrl = (process.env.PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

function adapter() {
  return new SslCommerzAdapter({
    storeId: storeId!,
    storePassword: storePassword!,
    sandbox: true,
    publicApiUrl,
    defaultCustomerPhone: process.env.SSLCOMMERZ_CUSTOMER_PHONE ?? '01700000000',
    timeoutMs: 20_000,
  });
}

const tranId = () => `TFSBX${randomUUID().replace(/-/g, '').slice(0, 20)}`;

describe('SSLCommerz sandbox (direct adapter calls)', () => {
  const gateway = adapter();

  it('PUBLIC_API_URL is a valid base for IPN and browser returns', () => {
    const url = new URL(publicApiUrl);
    expect(['http:', 'https:']).toContain(url.protocol);
    if (['localhost', '127.0.0.1'].includes(url.hostname)) expect(url.port).toBe('4000');
    expect(gateway.ipnUrl()).toBe(`${publicApiUrl}/api/payments/webhooks/SSLCOMMERZ`);
  });

  it('creates a hosted checkout session on the sandbox', async () => {
    const result = await gateway.initiatePayment({
      transactionRef: tranId(),
      amountMinor: 150_050,
      currency: 'BDT',
      customer: { name: 'Sandbox Tester', email: 'sandbox.tester@example.com' },
      description: 'TicketFlow sandbox check',
    });
    expect(result.status).toBe('REDIRECT');
    if (result.status !== 'REDIRECT') return;
    expect(new URL(result.redirectUrl).hostname).toBe('sandbox.sslcommerz.com');
    expect(result.metadata?.sessionkey).toEqual(expect.any(String));
  });

  it('an unpaid session verifies as PENDING (never as success or failure)', async () => {
    const ref = tranId();
    await gateway.initiatePayment({
      transactionRef: ref,
      amountMinor: 50_000,
      currency: 'BDT',
      customer: { name: 'Sandbox Tester', email: 'sandbox.tester@example.com' },
      description: 'TicketFlow sandbox pending check',
    });
    const verified = await gateway.verifyPayment({
      transactionRef: ref,
      amountMinor: 50_000,
      currency: 'BDT',
    });
    expect(verified.status).toBe('PENDING');
  });

  it('an unknown transaction reference is PENDING ("not recorded yet")', async () => {
    const verified = await gateway.verifyPayment({
      transactionRef: tranId(),
      amountMinor: 1000,
      currency: 'BDT',
    });
    expect(verified.status).toBe('PENDING');
  });

  it('a forged val_id fails Order Validation', async () => {
    const verified = await gateway.verifyPayment({
      transactionRef: tranId(),
      amountMinor: 1000,
      currency: 'BDT',
      providerPaymentId: `forged${randomUUID().slice(0, 8)}`,
    });
    expect(verified.status).toBe('FAILED');
  });

  it('the refund API accepts our v4 request shape and rejects an unknown bank_tran_id', async () => {
    const result = await gateway.refundPayment({
      transactionRef: tranId(),
      providerPaymentId: null,
      amountMinor: 1000,
      currency: 'BDT',
      idempotencyKey: `refund_sandbox_${randomUUID()}`,
      reason: 'Sandbox refund shape check',
      metadata: { bank_tran_id: `999${Date.now()}` },
    });
    expect(result.status).toBe('FAILED');
    // Rejected for the unknown transaction, not for missing/invalid fields or credentials.
    expect(result.failureReason ?? '').not.toMatch(/refund_trans_id|store|password|credential/i);
  });

  it('refund status of an unknown refund keeps polling instead of failing (no double refund)', async () => {
    const result = await gateway.refundStatus({ providerRefundId: `unknown${Date.now()}` });
    expect(result.status).toBe('PROCESSING');
  });
});

describe('SSLCommerz sandbox through the TicketFlow API', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true, paymentGateways: [adapter()] });
  });

  afterAll(async () => {
    await h.close();
  });

  it('starts a payment, keeps it pending on status checks, and cancels without charging', async () => {
    const held = await heldBooking(h);
    const started = await pay(held.agent, held.bookingId, { provider: 'SSLCOMMERZ' }).expect(201);
    const payment = started.body.data.payment as {
      id: string;
      status: string;
      redirectUrl: string;
    };
    expect(payment.status).toBe('PENDING');
    expect(new URL(payment.redirectUrl).hostname).toBe('sandbox.sslcommerz.com');
    expect(await bookingStatus(h, held.bookingId)).toBe('PENDING_PAYMENT');

    // Status poll re-verifies with SSLCommerz: still unpaid, so still pending.
    const polled = await held.agent.get(`/api/payments/${payment.id}`).expect(200);
    expect(polled.body.data.payment.status).toBe('PENDING');
    expect(polled.body.data.booking.status).toBe('PENDING_PAYMENT');

    // Cancelling verifies the open attempt first, then closes it; nothing to refund.
    const cancelled = await held.agent.post(`/api/bookings/${held.bookingId}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', refunds: [] });
    expect((await paymentRows(h, held.bookingId)).map((p) => p.status)).toEqual(['CANCELLED']);
  });

  it('a correctly signed IPN for an unpaid session cannot confirm the booking (server-side validation wins)', async () => {
    const held = await heldBooking(h);
    const started = await pay(held.agent, held.bookingId, { provider: 'SSLCOMMERZ' }).expect(201);
    const ref = started.body.data.payment.transactionRef as string;
    const body: Record<string, string> = {
      tran_id: ref,
      val_id: `forged${randomUUID().slice(0, 8)}`,
      amount: (held.totalMinor / 100).toFixed(2),
      currency: 'BDT',
      status: 'VALID',
      store_id: storeId!,
      bank_tran_id: `999${Date.now()}`,
      verify_key: 'amount,bank_tran_id,currency,status,store_id,tran_id,val_id',
    };
    const fields: Record<string, string> = {};
    for (const key of body.verify_key!.split(',')) fields[key] = body[key]!;
    fields.store_passwd = md5(storePassword!);
    body.verify_sign = md5(
      Object.keys(fields)
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join('&'),
    );

    await request(h.app)
      .post('/api/payments/webhooks/SSLCOMMERZ')
      .type('form')
      .send(body)
      .expect(200);
    expect(await bookingStatus(h, held.bookingId)).not.toBe('CONFIRMED');
    const [row] = await paymentRows(h, held.bookingId);
    expect(row!.status).not.toBe('SUCCEEDED');
  });

  it('an IPN with a wrong signature is rejected', async () => {
    const held = await heldBooking(h);
    const started = await pay(held.agent, held.bookingId, { provider: 'SSLCOMMERZ' }).expect(201);
    const response = await request(h.app)
      .post('/api/payments/webhooks/SSLCOMMERZ')
      .type('form')
      .send({
        tran_id: started.body.data.payment.transactionRef,
        val_id: 'x',
        status: 'VALID',
        verify_key: 'status,tran_id,val_id',
        verify_sign: md5('not-the-signature'),
      });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await bookingStatus(h, held.bookingId)).toBe('PENDING_PAYMENT');
  });
});
