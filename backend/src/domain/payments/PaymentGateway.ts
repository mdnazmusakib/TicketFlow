/**
 * Payment provider abstraction (Adapter pattern). Booking and payment
 * services only see this interface; switching providers never changes them.
 * Every adapter must be idempotent per `transactionRef` (payments) and per
 * `idempotencyKey` (refunds) so retries can never double charge or refund.
 */
export const PAYMENT_PROVIDERS = ['MOCK_PROVIDER_A', 'MOCK_PROVIDER_B', 'SSLCOMMERZ'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export interface CustomerInfo {
  name: string;
  email: string;
}

export interface InitiatePaymentInput {
  /** Our merchant transaction id (≤30 chars), the provider-side idempotency key. */
  transactionRef: string;
  amountMinor: number;
  currency: string;
  customer: CustomerInfo;
  description: string;
  /** Provider-specific client input, e.g. a tokenised card for direct-charge providers. */
  paymentMethodToken?: string;
}

export type InitiatePaymentResult =
  /** Customer must complete payment on a hosted page; outcome arrives via webhook/verification. */
  | {
      status: 'REDIRECT';
      redirectUrl: string;
      providerPaymentId?: string;
      metadata?: Record<string, unknown>;
    }
  /** Provider answered with a final result (still re-verified before confirming a booking). */
  | {
      status: 'SUCCEEDED' | 'FAILED';
      providerPaymentId?: string;
      failureReason?: string;
      metadata?: Record<string, unknown>;
    }
  /** Provider accepted the request but the result is not known yet. */
  | { status: 'PENDING'; providerPaymentId?: string; metadata?: Record<string, unknown> };

export interface VerifyPaymentInput {
  transactionRef: string;
  amountMinor: number;
  currency: string;
  /** Provider reference received in a callback (e.g. SSLCommerz val_id). */
  providerPaymentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Server-side truth obtained from the provider (never from the browser). */
export interface VerifyPaymentResult {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  providerPaymentId?: string;
  /** Amount and currency the provider reports; compared with our records before confirming. */
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

export interface RefundPaymentInput {
  transactionRef: string;
  providerPaymentId: string | null;
  amountMinor: number;
  currency: string;
  /** Unique per refund attempt; providers must treat repeats as the same refund. */
  idempotencyKey: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface RefundPaymentResult {
  status: 'SUCCEEDED' | 'PROCESSING' | 'FAILED';
  providerRefundId?: string;
  failureReason?: string;
}

export interface RefundStatusInput {
  providerRefundId: string;
  metadata?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: unknown;
}

export interface ParsedWebhook {
  /** False when the signature/hash does not match: the payload must not be trusted. */
  signatureValid: boolean;
  /** Provider event id (dedupe key); derived from the payload when the provider has none. */
  eventId: string;
  eventType: string;
  transactionRef: string | null;
  providerPaymentId: string | null;
  /** Payload with secrets removed, safe to store. */
  safePayload: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: PaymentProviderName;
  initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;
  /** Polls a refund still in PROCESSING. */
  refundStatus(input: RefundStatusInput): Promise<RefundPaymentResult>;
  parseWebhook(request: WebhookRequest): ParsedWebhook;
}

/** The provider call failed in a way that leaves the outcome unknown (timeout, 5xx, network). */
export class ProviderUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUncertainError';
  }
}

/** The provider rejected the request outright (nothing was charged/refunded). */
export class ProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

export class PaymentGatewayRegistry {
  private readonly gateways = new Map<PaymentProviderName, PaymentGateway>();

  constructor(gateways: PaymentGateway[] = []) {
    for (const gateway of gateways) this.register(gateway);
  }

  register(gateway: PaymentGateway): void {
    this.gateways.set(gateway.name, gateway);
  }

  has(name: string): name is PaymentProviderName {
    return this.gateways.has(name as PaymentProviderName);
  }

  get(name: PaymentProviderName): PaymentGateway {
    const gateway = this.gateways.get(name);
    if (!gateway) throw new Error(`Payment provider ${name} is not enabled`);
    return gateway;
  }

  enabled(): PaymentProviderName[] {
    return [...this.gateways.keys()];
  }
}
