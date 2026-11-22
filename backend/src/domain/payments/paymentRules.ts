/** Payment state machine (mirrored by the `enforce_payment_transition` trigger, migration 0007). */
export const PAYMENT_STATUSES = [
  'INITIATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  Object.freeze({
    INITIATED: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
    PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    // A verified capture always wins: money taken after we gave up must be recorded (and refunded).
    FAILED: ['SUCCEEDED'],
    CANCELLED: ['SUCCEEDED'],
    SUCCEEDED: [],
  });

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}

export function isOpenPayment(status: PaymentStatus): boolean {
  return status === 'INITIATED' || status === 'PENDING';
}

export const REFUND_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Full refund only when cancelled MORE than 24 hours before the event starts (PRD §3.11). */
export const FULL_REFUND_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface RefundDecision {
  refundable: boolean;
  refundAmountMinor: number;
  hoursUntilEvent: number;
}

export function decideRefund(params: {
  eventStartAt: Date;
  now: Date;
  paidAmountMinor: number;
}): RefundDecision {
  const msUntilEvent = params.eventStartAt.getTime() - params.now.getTime();
  const refundable = msUntilEvent > FULL_REFUND_THRESHOLD_MS && params.paidAmountMinor > 0;
  return {
    refundable,
    refundAmountMinor: refundable ? params.paidAmountMinor : 0,
    hoursUntilEvent: msUntilEvent / (60 * 60 * 1000),
  };
}

/** Exponential backoff for refund retries: 1, 2, 4, 8 … minutes, capped at 60. */
export function refundRetryDelayMs(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
}
