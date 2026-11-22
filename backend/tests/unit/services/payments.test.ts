import { createHash } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import {
  PaymentGatewayRegistry,
  ProviderRejectedError,
  ProviderUncertainError,
} from '../../../src/domain/payments/PaymentGateway';
import {
  FULL_REFUND_THRESHOLD_MS,
  canTransitionPayment,
  decideRefund,
  isOpenPayment,
  refundRetryDelayMs,
} from '../../../src/domain/payments/paymentRules';
import { MockPaymentLedger } from '../../../src/infrastructure/payments/MockPaymentLedger';
import { MockProviderA, MockProviderB } from '../../../src/infrastructure/payments/MockProviders';
import {
  SslCommerzAdapter,
  fromDecimalAmount,
  toDecimalAmount,
  verifySslCommerzSignature,
} from '../../../src/infrastructure/payments/SslCommerzAdapter';
import { RedisTtlStore } from '../../../src/infrastructure/redis/TtlStore';
import type {
  IdempotencyRecord,
  IdempotencyRepository,
} from '../../../src/repositories/IdempotencyRepository';
import { IdempotencyService, requestHash } from '../../../src/services/payments/IdempotencyService';
import { FakeSslCommerz, SSL_STORE } from '../../helpers/fakeSslCommerz';

const SECRET = 'unit-webhook-secret-0123456789abcdefghij';
let counter = 0;
function ledger(): MockPaymentLedger {
  counter += 1;
  const prefix = `pay${process.pid}u${counter}:`;
  return new MockPaymentLedger(
    new RedisTtlStore(new RedisMock({ keyPrefix: prefix }) as unknown as Redis, prefix),
  );
}
const charge = (ref: string, token?: string) => ({
  transactionRef: ref,
  amountMinor: 150000,
  currency: 'BDT',
  customer: { name: 'A', email: 'a@example.com' },
  description: 'Tickets',
  ...(token ? { paymentMethodToken: token } : {}),
});

describe('payment rules', () => {
  const start = new Date('2026-12-10T18:00:00Z');

  it('refunds fully only when MORE than 24 hours remain', () => {
    const at = (msBefore: number) => new Date(start.getTime() - msBefore);
    expect(
      decideRefund({
        eventStartAt: start,
        now: at(FULL_REFUND_THRESHOLD_MS + 1),
        paidAmountMinor: 500,
      }),
    ).toMatchObject({
      refundable: true,
      refundAmountMinor: 500,
    });
    expect(
      decideRefund({
        eventStartAt: start,
        now: at(FULL_REFUND_THRESHOLD_MS),
        paidAmountMinor: 500,
      }),
    ).toMatchObject({
      refundable: false,
      refundAmountMinor: 0,
      hoursUntilEvent: 24,
    });
    expect(
      decideRefund({
        eventStartAt: start,
        now: at(FULL_REFUND_THRESHOLD_MS - 1),
        paidAmountMinor: 500,
      }).refundable,
    ).toBe(false);
    expect(
      decideRefund({ eventStartAt: start, now: at(-HOUR()), paidAmountMinor: 500 }).refundable,
    ).toBe(false);
    expect(
      decideRefund({
        eventStartAt: start,
        now: at(FULL_REFUND_THRESHOLD_MS * 3),
        paidAmountMinor: 0,
      }).refundable,
    ).toBe(false);
  });

  it('payment transitions: verified capture wins, success is terminal', () => {
    expect(canTransitionPayment('INITIATED', 'PENDING')).toBe(true);
    expect(canTransitionPayment('PENDING', 'SUCCEEDED')).toBe(true);
    expect(canTransitionPayment('FAILED', 'SUCCEEDED')).toBe(true);
    expect(canTransitionPayment('CANCELLED', 'SUCCEEDED')).toBe(true);
    expect(canTransitionPayment('SUCCEEDED', 'FAILED')).toBe(false);
    expect(canTransitionPayment('FAILED', 'PENDING')).toBe(false);
    expect(isOpenPayment('INITIATED') && isOpenPayment('PENDING') && !isOpenPayment('FAILED')).toBe(
      true,
    );
  });

  it('refund backoff grows exponentially and is capped', () => {
    expect(refundRetryDelayMs(1)).toBe(60_000);
    expect(refundRetryDelayMs(3)).toBe(4 * 60_000);
    expect(refundRetryDelayMs(20)).toBe(60 * 60_000);
  });
});

function HOUR() {
  return 3_600_000;
}

describe('IdempotencyService', () => {
  function fakeRepo(existing: Partial<IdempotencyRecord> | null, insertedId: string | null = null) {
    return {
      tryInsert: jest.fn().mockResolvedValue(insertedId),
      find: jest.fn().mockResolvedValue(
        existing
          ? {
              id: 'rec',
              requestHash: requestHash({ a: 1 }),
              status: 'IN_PROGRESS',
              responseStatus: null,
              responseBody: null,
              lockedUntil: new Date(),
              lockExpired: false,
              ...existing,
            }
          : null,
      ),
      takeOver: jest.fn().mockResolvedValue(true),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      purgeExpired: jest.fn(),
    } as unknown as jest.Mocked<IdempotencyRepository>;
  }
  const scope = { userId: 'u', endpoint: 'POST /x', key: 'k-12345678', payload: { a: 1 } };

  it('runs once and stores the response', async () => {
    const repo = fakeRepo(null, 'new-id');
    const service = new IdempotencyService(repo);
    const result = await service.execute(scope, async () => ({ status: 201, body: { ok: true } }));
    expect(result).toEqual({ status: 201, body: { ok: true }, replayed: false });
    expect(repo.complete).toHaveBeenCalledWith('new-id', 201, { ok: true });
  });

  it('replays completed responses and rejects payload mismatches', async () => {
    const replay = new IdempotencyService(
      fakeRepo({ status: 'COMPLETED', responseStatus: 201, responseBody: { id: 1 } }),
    );
    const work = jest.fn();
    expect(await replay.execute(scope, work)).toEqual({
      status: 201,
      body: { id: 1 },
      replayed: true,
    });
    expect(work).not.toHaveBeenCalled();

    const mismatch = new IdempotencyService(fakeRepo({ requestHash: requestHash({ a: 2 }) }));
    await expect(mismatch.execute(scope, work)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_MISMATCH',
      statusCode: 422,
    });
  });

  it('reports in-progress duplicates and takes over abandoned ones', async () => {
    const busy = new IdempotencyService(fakeRepo({ lockExpired: false }));
    await expect(busy.execute(scope, jest.fn())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });

    const repo = fakeRepo({ lockExpired: true });
    const result = await new IdempotencyService(repo).execute(scope, async () => ({
      status: 200,
      body: 'ok',
    }));
    expect(result.replayed).toBe(false);
    expect(repo.takeOver).toHaveBeenCalledWith('rec', 60);

    const lost = fakeRepo({ lockExpired: true });
    lost.takeOver.mockResolvedValue(false);
    await expect(new IdempotencyService(lost).execute(scope, jest.fn())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('releases the key when the work fails so the client can retry', async () => {
    const repo = fakeRepo(null, 'id-1');
    await expect(
      new IdempotencyService(repo).execute(scope, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(repo.release).toHaveBeenCalledWith('id-1');
  });

  it('hashes payloads canonically (key order does not matter)', () => {
    expect(requestHash({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(
      requestHash({ a: [1, { x: 1, y: 2 }], b: 1 }),
    );
    expect(requestHash({ a: 1, b: undefined })).toBe(requestHash({ a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: '1' }));
  });
});

describe('Mock providers', () => {
  it('A: hosted checkout, idempotent per transaction, signed webhooks', async () => {
    const provider = new MockProviderA(ledger(), {
      checkoutUrl: 'http://localhost:5173/payments/mock-checkout',
      webhookSecret: SECRET,
    });
    const first = await provider.initiatePayment(charge('TFA0000000001'));
    expect(first).toMatchObject({ status: 'REDIRECT' });
    const again = await provider.initiatePayment(charge('TFA0000000001'));
    expect(again).toMatchObject({
      providerPaymentId: (first as { providerPaymentId: string }).providerPaymentId,
    });
    expect(
      await provider.verifyPayment({
        transactionRef: 'TFA0000000001',
        amountMinor: 1,
        currency: 'BDT',
      }),
    ).toMatchObject({ status: 'PENDING' });

    const delivery = await provider.completeCheckout('TFA0000000001', 'success');
    const parsed = provider.parseWebhook({
      headers: delivery.headers,
      rawBody: delivery.rawBody,
      body: JSON.parse(delivery.rawBody.toString()),
    });
    expect(parsed).toMatchObject({
      signatureValid: true,
      eventType: 'payment.succeeded',
      transactionRef: 'TFA0000000001',
    });
    expect(
      provider.parseWebhook({
        headers: { 'x-mock-signature': 'x' },
        rawBody: delivery.rawBody,
        body: {},
      }).signatureValid,
    ).toBe(false);
    // Completing again does not change a captured charge.
    await provider.completeCheckout('TFA0000000001', 'failure');
    expect(
      await provider.verifyPayment({
        transactionRef: 'TFA0000000001',
        amountMinor: 1,
        currency: 'BDT',
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      amountMinor: 150000,
    });
    await expect(provider.completeCheckout('TFA_unknown_ref', 'success')).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );

    const refund = await provider.refundPayment({
      transactionRef: 'TFA0000000001',
      providerPaymentId: null,
      amountMinor: 150000,
      currency: 'BDT',
      idempotencyKey: 'r1',
      reason: 'x',
    });
    const repeat = await provider.refundPayment({
      transactionRef: 'TFA0000000001',
      providerPaymentId: null,
      amountMinor: 150000,
      currency: 'BDT',
      idempotencyKey: 'r1',
      reason: 'x',
    });
    expect(refund.status).toBe('SUCCEEDED');
    expect(repeat.providerRefundId).toBe(refund.providerRefundId);
    expect(
      (
        await provider.refundPayment({
          transactionRef: 'nope',
          providerPaymentId: null,
          amountMinor: 1,
          currency: 'BDT',
          idempotencyKey: 'r2',
          reason: 'x',
        })
      ).status,
    ).toBe('FAILED');
    expect(
      await provider.verifyPayment({ transactionRef: 'nope', amountMinor: 1, currency: 'BDT' }),
    ).toMatchObject({ status: 'FAILED' });
  });

  it('B: tokens drive capture, decline, async settlement, timeout and refund failure', async () => {
    const provider = new MockProviderB(ledger(), { webhookSecret: SECRET });
    expect(await provider.initiatePayment(charge('TFB_success', 'tok_success'))).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(await provider.initiatePayment(charge('TFB_decline', 'tok_decline'))).toMatchObject({
      status: 'FAILED',
    });
    expect(await provider.initiatePayment(charge('TFB_pending', 'tok_pending'))).toMatchObject({
      status: 'PENDING',
    });
    expect(
      await provider.verifyPayment({
        transactionRef: 'TFB_pending',
        amountMinor: 1,
        currency: 'BDT',
      }),
    ).toMatchObject({ status: 'SUCCEEDED' });
    await expect(
      provider.initiatePayment(charge('TFB_timeout', 'tok_timeout')),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    // Retrying the same transaction does not charge again and reports the capture.
    expect(await provider.initiatePayment(charge('TFB_timeout', 'tok_timeout'))).toMatchObject({
      status: 'SUCCEEDED',
    });
    await expect(provider.initiatePayment(charge('TFB_bad', 'tok_nope'))).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );

    await provider.initiatePayment(charge('TFB_rf', 'tok_refund_fail_once'));
    const refundInput = {
      transactionRef: 'TFB_rf',
      providerPaymentId: null,
      amountMinor: 150000,
      currency: 'BDT',
      reason: 'x',
    };
    expect(await provider.refundPayment({ ...refundInput, idempotencyKey: 'a1' })).toMatchObject({
      status: 'FAILED',
    });
    expect(await provider.refundPayment({ ...refundInput, idempotencyKey: 'a1' })).toMatchObject({
      status: 'FAILED',
    }); // same attempt replays
    expect(await provider.refundPayment({ ...refundInput, idempotencyKey: 'a2' })).toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('B: timestamped signatures reject replays', () => {
    const provider = new MockProviderB(ledger(), { webhookSecret: SECRET });
    const body = { event_id: 'e1', event: 'payment.captured', reference: 'TFB1', payment_id: 'p1' };
    const fresh = provider.signWebhook(body);
    expect(
      provider.parseWebhook({ headers: fresh.headers, rawBody: fresh.rawBody, body })
        .signatureValid,
    ).toBe(true);
    const old = provider.signWebhook(body, Math.floor(Date.now() / 1000) - 3600);
    expect(
      provider.parseWebhook({ headers: old.headers, rawBody: old.rawBody, body }).signatureValid,
    ).toBe(false);
  });

  it('registry exposes only enabled providers', () => {
    const registry = new PaymentGatewayRegistry([
      new MockProviderB(ledger(), { webhookSecret: SECRET }),
    ]);
    expect(registry.enabled()).toEqual(['MOCK_PROVIDER_B']);
    expect(registry.has('SSLCOMMERZ')).toBe(false);
    expect(() => registry.get('SSLCOMMERZ')).toThrow('not enabled');
  });
});

describe('SSLCommerz adapter', () => {
  it('converts amounts and verifies IPN signatures as documented', () => {
    expect(toDecimalAmount(150050)).toBe('1500.50');
    expect(fromDecimalAmount('1500.50')).toBe(150050);
    expect(fromDecimalAmount('abc')).toBeUndefined();
    expect(fromDecimalAmount(undefined)).toBeUndefined();

    const fake = new FakeSslCommerz();
    fake.sessions.set('TFsig', {
      tranId: 'TFsig',
      amount: '100.00',
      currency: 'BDT',
      status: 'VALID',
      valId: 'v1',
      bankTranId: 'b1',
      riskLevel: '0',
    });
    const ipn = fake.ipn('TFsig');
    expect(verifySslCommerzSignature(ipn, SSL_STORE.storePassword)).toBe(true);
    expect(verifySslCommerzSignature({ ...ipn, status: 'FAILED' }, SSL_STORE.storePassword)).toBe(
      false,
    );
    expect(
      verifySslCommerzSignature({ ...ipn, verify_sign: undefined }, SSL_STORE.storePassword),
    ).toBe(false);
    // Independent reference implementation of the documented algorithm.
    const keys = ipn.verify_key!.split(',');
    const fields: Record<string, string> = Object.fromEntries(keys.map((k) => [k, ipn[k]!]));
    fields.store_passwd = createHash('md5').update(SSL_STORE.storePassword).digest('hex');
    const expected = createHash('md5')
      .update(
        Object.keys(fields)
          .sort()
          .map((k) => `${k}=${fields[k]}`)
          .join('&'),
      )
      .digest('hex');
    expect(ipn.verify_sign).toBe(expected);
  });

  it('maps HTTP failures: session errors are rejections, validation errors are uncertain', async () => {
    const down = new SslCommerzAdapter(
      {
        ...SSL_STORE,
        sandbox: true,
        publicApiUrl: 'http://localhost:4000',
        defaultCustomerPhone: '01700000000',
      },
      async () => new Response('oops', { status: 502 }),
    );
    await expect(down.initiatePayment(charge('TFdown'))).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
    await expect(
      down.verifyPayment({ transactionRef: 'TFdown', amountMinor: 1, currency: 'BDT' }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);

    const unreachable = new SslCommerzAdapter(
      {
        ...SSL_STORE,
        sandbox: false,
        publicApiUrl: 'https://api.example.com',
        defaultCustomerPhone: '01700000000',
      },
      async () => {
        throw new TypeError('fetch failed');
      },
    );
    await expect(
      unreachable.verifyPayment({
        transactionRef: 'x1234567',
        amountMinor: 1,
        currency: 'BDT',
        providerPaymentId: 'v',
      }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    expect(unreachable.ipnUrl()).toBe('https://api.example.com/api/payments/webhooks/SSLCOMMERZ');
  });

  it('looks up transactions by tran_id and maps statuses', async () => {
    const fake = new FakeSslCommerz();
    const adapter = fake.adapter();
    const session = await adapter.initiatePayment(charge('TFlookup1'));
    expect(session).toMatchObject({
      status: 'REDIRECT',
      metadata: { sessionkey: 'sess_TFlookup1' },
    });
    expect(
      await adapter.verifyPayment({
        transactionRef: 'TFlookup1',
        amountMinor: 150000,
        currency: 'BDT',
      }),
    ).toMatchObject({ status: 'PENDING' });
    fake.pay('TFlookup1');
    expect(
      await adapter.verifyPayment({
        transactionRef: 'TFlookup1',
        amountMinor: 150000,
        currency: 'BDT',
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      amountMinor: 150000,
      currency: 'BDT',
      metadata: { bank_tran_id: expect.any(String) },
    });
    fake.pay('TFlookup1', { status: 'FAILED' });
    expect(
      await adapter.verifyPayment({
        transactionRef: 'TFlookup1',
        amountMinor: 150000,
        currency: 'BDT',
      }),
    ).toMatchObject({ status: 'FAILED' });
    expect(
      await adapter.verifyPayment({ transactionRef: 'TFmissing', amountMinor: 1, currency: 'BDT' }),
    ).toMatchObject({ status: 'PENDING' });
    expect(
      await adapter.verifyPayment({
        transactionRef: 'TFother',
        amountMinor: 1,
        currency: 'BDT',
        providerPaymentId: 'valTFlookup1',
      }),
    ).toMatchObject({
      status: 'FAILED',
      failureReason: 'Transaction reference mismatch',
    });
    expect(
      await adapter.refundPayment({
        transactionRef: 'TFlookup1',
        providerPaymentId: null,
        amountMinor: 1,
        currency: 'BDT',
        idempotencyKey: 'k',
        reason: 'x',
      }),
    ).toMatchObject({
      status: 'FAILED',
      failureReason: 'Missing bank_tran_id for refund',
    });
    expect(await adapter.refundStatus({ providerRefundId: 'ref_1' })).toMatchObject({
      status: 'SUCCEEDED',
    });

    const badCreds = new SslCommerzAdapter(
      {
        storeId: 'x',
        storePassword: 'wrong',
        sandbox: true,
        publicApiUrl: 'http://localhost:4000',
        defaultCustomerPhone: '01700000000',
      },
      fake.fetch,
    );
    await expect(badCreds.initiatePayment(charge('TFbad'))).rejects.toThrow(
      'Store Credential Error',
    );
  });
});
