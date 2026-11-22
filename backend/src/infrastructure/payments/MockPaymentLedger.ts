import type { TtlStore } from '../redis/TtlStore';

/**
 * Provider-side state for the two mock gateways, kept in Redis so it survives
 * API restarts and is shared by every instance (like a real provider would be).
 * Charges are keyed by our transaction ref and refunds by idempotency key,
 * which is what makes the mocks idempotent: a retried request never creates a
 * second charge or refund.
 */
export type MockChargeStatus =
  'AWAITING_CUSTOMER' | 'PROCESSING' | 'CAPTURED' | 'DECLINED' | 'CANCELLED';

export interface MockCharge {
  providerPaymentId: string;
  transactionRef: string;
  amountMinor: number;
  currency: string;
  status: MockChargeStatus;
  token?: string;
  refundAttempts: number;
  createdAt: string;
}

export interface MockRefund {
  providerRefundId: string;
  transactionRef: string;
  amountMinor: number;
  status: 'SUCCEEDED' | 'FAILED';
  failureReason?: string;
}

const TTL_SECONDS = 30 * 24 * 60 * 60;

export class MockPaymentLedger {
  constructor(private readonly store: TtlStore) {}

  private chargeKey(provider: string, ref: string): string {
    return `mockpay:${provider}:charge:${ref}`;
  }

  private refundKey(provider: string, key: string): string {
    return `mockpay:${provider}:refund:${key}`;
  }

  /** Creates the charge if it does not exist yet; always returns the stored one. */
  async createCharge(
    provider: string,
    charge: MockCharge,
  ): Promise<{ charge: MockCharge; created: boolean }> {
    const created = await this.store.setIfAbsent(
      this.chargeKey(provider, charge.transactionRef),
      JSON.stringify(charge),
      TTL_SECONDS,
    );
    const stored = await this.getCharge(provider, charge.transactionRef);
    return { charge: stored ?? charge, created };
  }

  async getCharge(provider: string, ref: string): Promise<MockCharge | null> {
    const raw = await this.store.get(this.chargeKey(provider, ref));
    return raw ? (JSON.parse(raw) as MockCharge) : null;
  }

  async updateCharge(
    provider: string,
    ref: string,
    patch: Partial<MockCharge>,
  ): Promise<MockCharge | null> {
    const current = await this.getCharge(provider, ref);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.store.set(this.chargeKey(provider, ref), JSON.stringify(next), TTL_SECONDS);
    return next;
  }

  async findRefund(provider: string, key: string): Promise<MockRefund | null> {
    const raw = await this.store.get(this.refundKey(provider, key));
    return raw ? (JSON.parse(raw) as MockRefund) : null;
  }

  /** Stores the refund result for this idempotency key once; repeats return the first result. */
  async recordRefund(provider: string, key: string, refund: MockRefund): Promise<MockRefund> {
    await this.store.setIfAbsent(
      this.refundKey(provider, key),
      JSON.stringify(refund),
      TTL_SECONDS,
    );
    return (await this.findRefund(provider, key)) ?? refund;
  }
}
