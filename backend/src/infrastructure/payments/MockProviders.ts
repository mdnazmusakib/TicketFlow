import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ProviderRejectedError,
  ProviderUncertainError,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type ParsedWebhook,
  type PaymentGateway,
  type RefundPaymentInput,
  type RefundPaymentResult,
  type RefundStatusInput,
  type VerifyPaymentInput,
  type VerifyPaymentResult,
  type WebhookRequest,
} from '../../domain/payments/PaymentGateway';
import type { MockCharge, MockPaymentLedger } from './MockPaymentLedger';

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function verifyFromCharge(charge: MockCharge | null): VerifyPaymentResult {
  if (!charge) return { status: 'FAILED', failureReason: 'Unknown transaction' };
  const base = {
    providerPaymentId: charge.providerPaymentId,
    amountMinor: charge.amountMinor,
    currency: charge.currency,
  };
  switch (charge.status) {
    case 'CAPTURED':
      return { status: 'SUCCEEDED', ...base };
    case 'DECLINED':
      return { status: 'FAILED', ...base, failureReason: 'Payment declined' };
    case 'CANCELLED':
      return { status: 'FAILED', ...base, failureReason: 'Payment cancelled' };
    default:
      return { status: 'PENDING', ...base };
  }
}

export interface MockWebhookDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/**
 * Mock Provider A — hosted checkout page + signed webhook (like most card
 * gateways). The customer completes payment on our simulated provider page;
 * the provider then notifies us with an HMAC-SHA256 signed webhook.
 */
export class MockProviderA implements PaymentGateway {
  readonly name = 'MOCK_PROVIDER_A' as const;

  constructor(
    private readonly ledger: MockPaymentLedger,
    private readonly options: { checkoutUrl: string; webhookSecret: string },
  ) {}

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const { charge } = await this.ledger.createCharge(this.name, {
      providerPaymentId: `mpa_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      transactionRef: input.transactionRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'AWAITING_CUSTOMER',
      refundAttempts: 0,
      createdAt: new Date().toISOString(),
    });
    if (charge.status === 'CAPTURED')
      return { status: 'SUCCEEDED', providerPaymentId: charge.providerPaymentId };
    const url = new URL(this.options.checkoutUrl);
    url.searchParams.set('ref', input.transactionRef);
    return {
      status: 'REDIRECT',
      redirectUrl: url.toString(),
      providerPaymentId: charge.providerPaymentId,
    };
  }

  /** Simulates the customer paying/declining on the hosted page; returns the webhook the provider sends. */
  async completeCheckout(
    transactionRef: string,
    outcome: 'success' | 'failure',
  ): Promise<MockWebhookDelivery> {
    const charge = await this.ledger.getCharge(this.name, transactionRef);
    if (!charge) throw new ProviderRejectedError('Unknown transaction');
    const updated =
      charge.status === 'AWAITING_CUSTOMER'
        ? await this.ledger.updateCharge(this.name, transactionRef, {
            status: outcome === 'success' ? 'CAPTURED' : 'DECLINED',
          })
        : charge;
    return this.buildWebhook(updated ?? charge);
  }

  buildWebhook(charge: MockCharge): MockWebhookDelivery {
    const body = JSON.stringify({
      id: `evt_${charge.providerPaymentId}_${charge.status}`,
      type: charge.status === 'CAPTURED' ? 'payment.succeeded' : 'payment.failed',
      data: {
        transactionRef: charge.transactionRef,
        providerPaymentId: charge.providerPaymentId,
        amountMinor: charge.amountMinor,
        currency: charge.currency,
        status: charge.status,
      },
    });
    const rawBody = Buffer.from(body);
    return {
      rawBody,
      headers: { 'x-mock-signature': hmacHex(this.options.webhookSecret, rawBody) },
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return verifyFromCharge(await this.ledger.getCharge(this.name, input.transactionRef));
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const existing = await this.ledger.findRefund(this.name, input.idempotencyKey);
    if (existing) return { status: existing.status, providerRefundId: existing.providerRefundId };
    const charge = await this.ledger.getCharge(this.name, input.transactionRef);
    const ok = charge?.status === 'CAPTURED' && input.amountMinor <= charge.amountMinor;
    const refund = await this.ledger.recordRefund(this.name, input.idempotencyKey, {
      providerRefundId: `mra_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      transactionRef: input.transactionRef,
      amountMinor: input.amountMinor,
      status: ok ? 'SUCCEEDED' : 'FAILED',
      ...(ok ? {} : { failureReason: 'Charge not refundable' }),
    });
    return {
      status: refund.status,
      providerRefundId: refund.providerRefundId,
      ...(refund.failureReason ? { failureReason: refund.failureReason } : {}),
    };
  }

  async refundStatus(input: RefundStatusInput): Promise<RefundPaymentResult> {
    return { status: 'SUCCEEDED', providerRefundId: input.providerRefundId };
  }

  parseWebhook(request: WebhookRequest): ParsedWebhook {
    const signature = header(request.headers, 'x-mock-signature') ?? '';
    const expected = hmacHex(this.options.webhookSecret, request.rawBody);
    const body = (request.body ?? {}) as {
      id?: unknown;
      type?: unknown;
      data?: Record<string, unknown>;
    };
    const data = body.data ?? {};
    return {
      signatureValid: signature.length > 0 && safeEqualHex(signature, expected),
      eventId: typeof body.id === 'string' ? body.id : `unidentified:${expected.slice(0, 24)}`,
      eventType: typeof body.type === 'string' ? body.type : 'unknown',
      transactionRef: typeof data.transactionRef === 'string' ? data.transactionRef : null,
      providerPaymentId: typeof data.providerPaymentId === 'string' ? data.providerPaymentId : null,
      safePayload: { id: body.id, type: body.type, data },
    };
  }
}

/**
 * Mock Provider B — direct server-to-server charge with a tokenised card and
 * asynchronous settlement (exercises uncertain outcomes). Test tokens:
 *   tok_success            immediate capture
 *   tok_decline            declined
 *   tok_pending            accepted, settles on the next status check
 *   tok_timeout            captured, but the response is lost (timeout)
 *   tok_refund_fail_once   captured; the first refund attempt fails, retries succeed
 */
export class MockProviderB implements PaymentGateway {
  readonly name = 'MOCK_PROVIDER_B' as const;
  static readonly TOKENS = [
    'tok_success',
    'tok_decline',
    'tok_pending',
    'tok_timeout',
    'tok_refund_fail_once',
  ] as const;

  constructor(
    private readonly ledger: MockPaymentLedger,
    private readonly options: { webhookSecret: string },
  ) {}

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const token = input.paymentMethodToken ?? '';
    if (!(MockProviderB.TOKENS as readonly string[]).includes(token)) {
      throw new ProviderRejectedError('Invalid or missing card token');
    }
    const status =
      token === 'tok_decline' ? 'DECLINED' : token === 'tok_pending' ? 'PROCESSING' : 'CAPTURED';
    const { charge, created } = await this.ledger.createCharge(this.name, {
      providerPaymentId: `mpb_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      transactionRef: input.transactionRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status,
      token,
      refundAttempts: 0,
      createdAt: new Date().toISOString(),
    });
    if (created && token === 'tok_timeout') {
      // Money captured, response lost: the caller must not retry blindly.
      throw new ProviderUncertainError('Provider B timed out after accepting the charge');
    }
    const result = verifyFromCharge(charge);
    if (result.status === 'SUCCEEDED')
      return { status: 'SUCCEEDED', providerPaymentId: charge.providerPaymentId };
    if (result.status === 'FAILED') {
      return {
        status: 'FAILED',
        providerPaymentId: charge.providerPaymentId,
        failureReason: result.failureReason ?? 'Declined',
      };
    }
    return { status: 'PENDING', providerPaymentId: charge.providerPaymentId };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    let charge = await this.ledger.getCharge(this.name, input.transactionRef);
    if (charge?.status === 'PROCESSING') {
      // Asynchronous settlement completes by the time anyone asks again.
      charge = await this.ledger.updateCharge(this.name, input.transactionRef, {
        status: 'CAPTURED',
      });
    }
    return verifyFromCharge(charge);
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const existing = await this.ledger.findRefund(this.name, input.idempotencyKey);
    if (existing) {
      return {
        status: existing.status,
        providerRefundId: existing.providerRefundId,
        ...(existing.failureReason ? { failureReason: existing.failureReason } : {}),
      };
    }
    const charge = await this.ledger.getCharge(this.name, input.transactionRef);
    if (!charge || charge.status !== 'CAPTURED') {
      return { status: 'FAILED', failureReason: 'Charge not refundable' };
    }
    const attempts = charge.refundAttempts + 1;
    await this.ledger.updateCharge(this.name, input.transactionRef, { refundAttempts: attempts });
    const fail = charge.token === 'tok_refund_fail_once' && attempts === 1;
    const refund = await this.ledger.recordRefund(this.name, input.idempotencyKey, {
      providerRefundId: `mrb_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      transactionRef: input.transactionRef,
      amountMinor: input.amountMinor,
      status: fail ? 'FAILED' : 'SUCCEEDED',
      ...(fail ? { failureReason: 'Issuer temporarily unavailable' } : {}),
    });
    return {
      status: refund.status,
      providerRefundId: refund.providerRefundId,
      ...(refund.failureReason ? { failureReason: refund.failureReason } : {}),
    };
  }

  async refundStatus(input: RefundStatusInput): Promise<RefundPaymentResult> {
    return { status: 'SUCCEEDED', providerRefundId: input.providerRefundId };
  }

  /** Provider B signs `timestamp.body` and sends both in headers (replays older than 5 minutes are rejected). */
  parseWebhook(request: WebhookRequest): ParsedWebhook {
    const timestamp = header(request.headers, 'x-mockb-timestamp') ?? '';
    const signature = header(request.headers, 'x-mockb-signature') ?? '';
    const expected = hmacHex(
      this.options.webhookSecret,
      `${timestamp}.${request.rawBody.toString('utf8')}`,
    );
    const fresh =
      /^\d+$/.test(timestamp) && Math.abs(Date.now() - Number(timestamp) * 1000) < 5 * 60_000;
    const body = (request.body ?? {}) as {
      event_id?: unknown;
      event?: unknown;
      reference?: unknown;
      payment_id?: unknown;
    };
    return {
      signatureValid: fresh && signature.length > 0 && safeEqualHex(signature, expected),
      eventId:
        typeof body.event_id === 'string' ? body.event_id : `unidentified:${expected.slice(0, 24)}`,
      eventType: typeof body.event === 'string' ? body.event : 'unknown',
      transactionRef: typeof body.reference === 'string' ? body.reference : null,
      providerPaymentId: typeof body.payment_id === 'string' ? body.payment_id : null,
      safePayload: {
        event_id: body.event_id,
        event: body.event,
        reference: body.reference,
        payment_id: body.payment_id,
      },
    };
  }

  /** Test helper: builds a correctly signed Provider B webhook. */
  signWebhook(
    body: Record<string, unknown>,
    timestamp = Math.floor(Date.now() / 1000),
  ): MockWebhookDelivery {
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        'x-mockb-timestamp': String(timestamp),
        'x-mockb-signature': hmacHex(
          this.options.webhookSecret,
          `${timestamp}.${rawBody.toString('utf8')}`,
        ),
      },
    };
  }
}
